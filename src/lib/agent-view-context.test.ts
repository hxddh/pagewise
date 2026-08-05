import { describe, expect, it, beforeEach } from "vitest";
import {
  rollbackLastAgentMessage,
  beginAgentMessage,
  consumePendingAgentContext,
  clearAgentMessageContext,
  appendContextToLastUserMessage,
  buildViewContextInstructions,
  buildWholeDocumentInstructions,
  type AgentMessageContext,
} from "./agent-view-context";

const ctx = (over: Partial<AgentMessageContext> = {}): AgentMessageContext => ({
  path: "/a.pdf",
  docName: "report",
  viewingPage: 3,
  totalPages: 10,
  userText: "summarize the whole document",
  includeViewingPage: true,
  ...over,
});

describe("agent-view-context", () => {
  beforeEach(() => {
    clearAgentMessageContext();
  });
  it("rollbackLastAgentMessage removes the last pending context", () => {
    beginAgentMessage({
      path: "/a.pdf",
      docName: "a",
      viewingPage: 1,
      totalPages: 1,
      userText: "first",
      includeViewingPage: true,
    });
    beginAgentMessage({
      path: "/b.pdf",
      docName: "b",
      viewingPage: 2,
      totalPages: 2,
      userText: "second",
      includeViewingPage: true,
    });
    rollbackLastAgentMessage();
    expect(consumePendingAgentContext()?.path).toBe("/a.pdf");
    consumePendingAgentContext();
    expect(consumePendingAgentContext()).toBeNull();
  });

  it("view instructions keep the page facts and stay lean", () => {
    const out = buildViewContextInstructions(ctx());
    expect(out).toContain("report");
    expect(out).toContain("10 pages");
    expect(out).toContain("page 3"); // viewing page preserved
    expect(out.length).toBeLessThan(320); // trimmed from the old prescriptive block
  });

  it("always shares the page number, even when the screenshot preference is off", () => {
    const out = buildViewContextInstructions(ctx({ includeViewingPage: false }));
    expect(out).toContain("report");
    expect(out).toContain("page 3"); // page number is decoupled from the screenshot toggle
  });

  it("omits the viewing-page hint when there is no valid viewing page", () => {
    const out = buildViewContextInstructions(ctx({ viewingPage: 0 }));
    expect(out).toContain("report");
    expect(out).not.toContain("viewing");
  });

  it("whole-document instructions keep the essential directives, drop the numbered script", () => {
    const out = buildWholeDocumentInstructions(ctx());
    expect(out).toContain("document_outline");
    expect(out).toContain("read_pdf_range");
    expect(out).toContain("truncated"); // continue-until-done hint kept
    expect(out).toContain("budgetExceeded"); // budget-stop hint kept
    expect(out).not.toMatch(/^\s*1\./m); // no rigid numbered steps
    expect(out.length).toBeLessThan(420);
  });
});

describe("appendContextToLastUserMessage", () => {
  it("puts the volatile context on the newest user message, not the system prompt", () => {
    const messages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "an answer" },
      { role: "user", content: "second question" },
    ];
    const out = appendContextToLastUserMessage(messages, "\n\nActive document: 'a.pdf'.");

    expect(out).not.toBe(messages);
    expect(out?.[2]?.content).toContain("second question");
    expect(out?.[2]?.content).toContain("Active document");
    // Everything before it is untouched — that is the part a provider caches.
    expect(out?.[0]).toBe(messages[0]);
    expect(out?.[1]).toBe(messages[1]);
  });

  it("appends a text part when the message has structured content", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "look at this" }] },
    ];
    const out = appendContextToLastUserMessage(messages, "\n\nviewing page 4");
    expect(out?.[0]?.content).toEqual([
      { type: "text", text: "look at this" },
      { type: "text", text: "\n\nviewing page 4" },
    ]);
  });

  it("leaves everything alone when there is nothing to say or nowhere to put it", () => {
    const messages = [{ role: "user", content: "q" }];
    expect(appendContextToLastUserMessage(messages, "")).toBe(messages);
    expect(appendContextToLastUserMessage(messages, "   ")).toBe(messages);
    expect(appendContextToLastUserMessage([], "hint")).toEqual([]);
    expect(appendContextToLastUserMessage(undefined, "hint")).toBeUndefined();
    const noUser = [{ role: "assistant", content: "a" }];
    expect(appendContextToLastUserMessage(noUser, "hint")).toBe(noUser);
  });
});
