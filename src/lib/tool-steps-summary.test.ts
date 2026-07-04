import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  segmentMessageParts,
  summarizeToolSteps,
  toolStepLabel,
  type ToolStepInfo,
} from "./tool-steps-summary";

const t = (key: string, vars?: Record<string, string | number>) => {
  const map: Record<string, string> = {
    "agent.toolSearch": `已搜索“${vars?.query ?? ""}”`,
    "agent.toolWorking": "已调用工具",
    "agent.toolReadPage": `已读取第 ${vars?.page} 页`,
    "agent.toolIndex": "已浏览文档",
    "agent.activitySearch": "正在搜索文档…",
    "agent.activityReadRange": "正在阅读页面…",
    "agent.activityWorking": "处理中…",
    "agent.toolsSummarySearch": `已搜索 ${vars?.count} 次`,
    "agent.toolsSummaryRead": `已读取 ${vars?.count} 次`,
    "agent.toolsSummaryIndex": `已浏览文档 ${vars?.count} 次`,
    "agent.toolsSummaryOther": `已调用工具 ${vars?.count} 次`,
    "agent.toolsSummarySep": " · ",
    "agent.toolsSummarySteps": `已完成 ${vars?.count} 个步骤`,
  };
  return map[key] ?? key;
};

describe("summarizeToolSteps", () => {
  it("does not aggregate a single step", () => {
    const steps: ToolStepInfo[] = [
      {
        toolName: "search_in_document",
        bucket: "search",
        label: "已搜索“foo”",
        key: "search:foo",
        running: false,
      },
    ];
    const s = summarizeToolSteps(steps, t);
    expect(s.aggregate).toBe(false);
    expect(s.summary).toBe("已搜索“foo”");
  });

  it("aggregates repeated searches", () => {
    const mk = (query: string): ToolStepInfo => ({
      toolName: "search_in_document",
      bucket: "search",
      label: `已搜索“${query}”`,
      key: `search:${query}`,
      running: false,
    });
    const s = summarizeToolSteps(
      [mk("庞莱臣"), mk("庞增和"), mk("庞叔令"), mk("庞莱臣")],
      t,
    );
    expect(s.aggregate).toBe(true);
    expect(s.summary).toBe("已搜索 4 次");
    expect(s.details).toEqual([
      { label: "已搜索“庞莱臣”", count: 2 },
      { label: "已搜索“庞增和”", count: 1 },
      { label: "已搜索“庞叔令”", count: 1 },
    ]);
  });

  it("aggregates mixed tool types", () => {
    const s = summarizeToolSteps(
      [
        {
          toolName: "search_in_document",
          bucket: "search",
          label: "已搜索“a”",
          key: "search:a",
          running: false,
        },
        {
          toolName: "read_pdf_page",
          bucket: "read",
          label: "已读取第 3 页",
          key: "read:3",
          running: false,
        },
        {
          toolName: "list_documents",
          bucket: "other",
          label: "已调用工具",
          key: "other:list_documents",
          running: false,
        },
      ],
      t,
    );
    expect(s.summary).toBe("已搜索 1 次 · 已读取 1 次 · 已调用工具 1 次");
  });

  it("shows live progress while a tool is running", () => {
    const s = summarizeToolSteps(
      [
        {
          toolName: "search_in_document",
          bucket: "search",
          label: "已搜索“南京博物院”",
          key: "search:南京博物院",
          running: false,
        },
        {
          toolName: "read_pdf_page",
          bucket: "read",
          label: "正在阅读页面…",
          key: "read_pdf_page:tc2",
          running: true,
        },
      ],
      t,
    );
    expect(s.aggregate).toBe(true);
    expect(s.summary).toBe("已搜索 1 次 · 正在阅读页面…");
    expect(s.anyRunning).toBe(true);
  });
});

describe("segmentMessageParts", () => {
  it("groups consecutive tool parts", () => {
    const parts = [
      { type: "tool-search_in_document", toolCallId: "1", state: "output-available" },
      { type: "tool-read_pdf_page", toolCallId: "2", state: "output-available" },
      { type: "text", text: "answer" },
    ] as unknown as UIMessage["parts"];

    const segments = segmentMessageParts(parts);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.kind).toBe("tools");
    expect(segments[1]?.kind).toBe("part");
  });

  it("groups tools across step-start boundaries", () => {
    const parts = [
      { type: "step-start" },
      {
        type: "tool-search_in_document",
        toolCallId: "1",
        state: "output-available",
        input: { query: "南京博物院" },
      },
      { type: "step-start" },
      {
        type: "tool-search_in_document",
        toolCallId: "2",
        state: "output-available",
        input: { query: "南京博物院" },
      },
      { type: "text", text: "answer" },
    ] as unknown as UIMessage["parts"];

    const segments = segmentMessageParts(parts);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.kind).toBe("tools");
    if (segments[0]?.kind === "tools") {
      expect(segments[0].parts).toHaveLength(2);
    }
  });

  it("groups tools separated by reasoning parts", () => {
    const parts = [
      {
        type: "tool-search_in_document",
        toolCallId: "1",
        state: "output-available",
        input: { query: "江南春" },
      },
      { type: "reasoning", text: "planning next search" },
      {
        type: "tool-search_in_document",
        toolCallId: "2",
        state: "output-available",
        input: { query: "江南春" },
      },
      { type: "tool-list_documents", toolCallId: "3", state: "output-available" },
      {
        type: "tool-get_document_index",
        toolCallId: "4",
        state: "output-available",
      },
      { type: "text", text: "answer" },
    ] as unknown as UIMessage["parts"];

    const segments = segmentMessageParts(parts);
    expect(segments).toHaveLength(3);
    expect(segments[0]?.kind).toBe("tools");
    if (segments[0]?.kind === "tools") {
      expect(segments[0].parts).toHaveLength(4);
    }
    expect(segments[1]?.kind).toBe("part");
    if (segments[1]?.kind === "part") {
      expect(segments[1].part.type).toBe("reasoning");
    }
    expect(segments[2]?.kind).toBe("part");
  });

  it("keeps intro text before the tool block", () => {
    const parts = [
      { type: "text", text: "让我搜索一下" },
      {
        type: "tool-search_in_document",
        toolCallId: "1",
        state: "output-available",
        input: { query: "江南春" },
      },
      { type: "text", text: "answer" },
    ] as unknown as UIMessage["parts"];

    const segments = segmentMessageParts(parts);
    expect(segments).toHaveLength(3);
    expect(segments[0]?.kind).toBe("part");
    if (segments[0]?.kind === "part") {
      expect(segments[0].part.type).toBe("text");
    }
    expect(segments[1]?.kind).toBe("tools");
    expect(segments[2]?.kind).toBe("part");
  });
});

describe("toolStepLabel", () => {
  it("builds stable keys for search queries", () => {
    const { key, bucket } = toolStepLabel(
      "search_in_document",
      { query: "测试" },
      t,
    );
    expect(key).toBe("search:测试");
    expect(bucket).toBe("search");
  });
});
