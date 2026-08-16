import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const ROOT_DIR = fileURLToPath(new URL("../..", import.meta.url));

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

/**
 * The field the hint is actually attached to.
 *
 * `appendContextToLastUserMessage` had eight passing tests above and was a
 * no-op in production for as long as it existed: `prepareCall` receives the
 * model messages under `prompt`, and agent.ts read `rest.messages`, which is
 * undefined. The hint was built every turn and thrown away — the active
 * document, the page the reader was viewing, the whole-document instructions,
 * all of it — and nothing failed.
 *
 * Its own tests could not see this. They pass an array in and assert on the
 * array out, which was always correct; the loss was one layer up, in the name
 * of the field the result was assigned to. The same shape as the page-citation
 * defect in 8.1.8, and found the same way: by dumping the request body the
 * provider actually receives.
 *
 * This pins the field name so the carrier cannot go quiet again.
 */
describe("the field prepareCall carries messages on", () => {
  it("is `prompt`, and agent.ts appends to that one", () => {
    const source = readFileSync(join(ROOT_DIR, "src/lib/agent.ts"), "utf8");
    const call = source.slice(source.indexOf("appendContextToLastUserMessage("));
    expect(
      call.slice(0, 200),
      "the hint must be appended to `rest.prompt`; `rest.messages` is undefined here",
    ).toContain("rest.prompt");
    expect(
      source,
      "and the result must be returned as `prompt`, or the appended copy is discarded",
    ).toMatch(/\n\s*prompt: appendContextToLastUserMessage\(/);
  });
});
