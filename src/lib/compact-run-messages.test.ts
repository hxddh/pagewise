import { describe, expect, it } from "vitest";
import { compactRunMessages, KEEP_RECENT_CHARS } from "./compact-run-messages";

type Msg = { role: string; content: unknown };

function read(id: string, page: number, chars: number): Msg[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: id, toolName: "read_pdf_page", input: { page } },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "read_pdf_page",
          output: { type: "json", value: { text: "x".repeat(chars), page } },
        },
      ],
    },
  ];
}

function sizeOf(messages: readonly Msg[]): number {
  return JSON.stringify(messages).length;
}

function outputs(messages: readonly Msg[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      out.push((part as { output?: { value?: unknown } }).output?.value);
    }
  }
  return out;
}

describe("compactRunMessages", () => {
  it("keeps the newest result whole however large it is", () => {
    const messages: Msg[] = [
      { role: "user", content: "q" },
      ...read("big", 1, 40_000),
      ...read("bigger", 2, 40_000),
    ];
    const values = outputs(compactRunMessages(messages) as Msg[]);
    // One result larger than the whole budget still goes through intact —
    // dropping what the model is reasoning over right now would be worse than
    // the tokens it costs.
    expect(typeof values[1]).toBe("object");
  });

  it("leaves a short run untouched — the model is still using those results", () => {
    const messages: Msg[] = [
      { role: "user", content: "what does it say" },
      ...read("a", 1, 6000),
      ...read("b", 2, 6000),
    ];
    expect(compactRunMessages(messages)).toBe(messages);
  });

  it("shortens the reads the model has moved past", () => {
    const messages: Msg[] = [{ role: "user", content: "summarize" }];
    for (let i = 1; i <= 10; i++) messages.push(...read(`c${i}`, i, 6000));

    const before = sizeOf(messages);
    const after = compactRunMessages(messages);
    const size = sizeOf(after as Msg[]);

    // What is left is the pages still in play, not ten copies of the document:
    // the payload is bounded by how many results are kept, not by how many
    // pages the run has read.
    expect(before).toBeGreaterThan(60_000);
    // Bounded by the keep budget, not by how many pages the run has read.
    expect(size).toBeLessThan(KEEP_RECENT_CHARS + 6_000);
    // The newest results survive at full length.
    const values = outputs(after as Msg[]);
    expect(values).toHaveLength(10);
    // The newest survive whole; the oldest are summaries.
    expect(typeof values[values.length - 1]).toBe("object");
    expect(String(values[0])).toMatch(/^\[Read page \d+, 6000 chars/);
  });

  it("keeps every tool call paired with a result", () => {
    const messages: Msg[] = [{ role: "user", content: "q" }];
    for (let i = 1; i <= 8; i++) messages.push(...read(`d${i}`, i, 3000));

    const after = compactRunMessages(messages) as Msg[];
    expect(after).toHaveLength(messages.length);
    const calls = after.filter((m) => m.role === "assistant").length;
    const results = after.filter((m) => m.role === "tool").length;
    expect(calls).toBe(8);
    expect(results).toBe(8);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const messages: Msg[] = [{ role: "user", content: "q" }];
    for (let i = 1; i <= 9; i++) messages.push(...read(`e${i}`, i, 4000));

    const once = compactRunMessages(messages);
    const twice = compactRunMessages(once);
    expect(twice).toBe(once);
  });

  it("does not touch a figure description — it cost a billed vision call", () => {
    const messages: Msg[] = [{ role: "user", content: "q" }];
    for (let i = 1; i <= 8; i++) messages.push(...read(`f${i}`, i, 2000));
    messages.splice(1, 0, {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "fig",
          toolName: "read_figure",
          output: { type: "json", value: { description: "a bar chart of revenue" } },
        },
      ],
    });

    const after = compactRunMessages(messages) as Msg[];
    const figure = after
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((p) => (p as { toolCallId?: string }).toolCallId === "fig");
    expect((figure as { output: { value: unknown } }).output.value).toEqual({
      description: "a bar chart of revenue",
    });
  });

  it("survives messages with no tool traffic at all", () => {
    const messages: Msg[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    expect(compactRunMessages(messages)).toBe(messages);
    expect(compactRunMessages(undefined)).toEqual([]);
  });
});

/**
 * A long run never leaves a page it read out of reach (24.0).
 *
 * The replay reads every page of a document in order, as a list-every-term
 * question does, with compaction between steps exactly as `prepareStep` runs
 * it. At the last step every page must either still be in the context at full
 * length, or come back with its text when asked for again. Before 24.0 the
 * first pages were in neither place: shortened away, and answered "already
 * returned in full".
 */
describe("a long run can still quote its first pages (24.0)", () => {
  it("leaves every page either in context or re-readable", async () => {
    const { newReadBudget, alreadyDelivered, markDelivered, forgetDelivered } = await import(
      "./agent-tools/reading"
    );
    const budget = newReadBudget();
    const PATH = "/docs/gpl-3.0.pdf";
    let messages: Msg[] = [{ role: "user", content: "list every obligation" }];
    for (let page = 1; page <= 10; page++) {
      messages = compactRunMessages(messages, KEEP_RECENT_CHARS, (pages) => {
        for (const p of pages) forgetDelivered(budget, p);
      }) as Msg[];
      messages = [...messages, ...read(`r${page}`, page, 3500)];
      markDelivered(budget, PATH, page);
    }
    messages = compactRunMessages(messages, KEEP_RECENT_CHARS, (pages) => {
      for (const p of pages) forgetDelivered(budget, p);
    }) as Msg[];

    const inContext = new Set(
      outputs(messages)
        .filter((v): v is { page: number } => typeof v === "object" && v !== null)
        .map((v) => v.page),
    );
    const lost = [...Array(10).keys()].map((i) => i + 1).filter((p) => !inContext.has(p) && alreadyDelivered(budget, PATH, p));
    expect(inContext.size, "compaction did run").toBeLessThan(10);
    expect(lost).toEqual([]);
  });

  it("names the pages a range carried", async () => {
    const { pagesInResult } = await import("./compact-run-messages");
    expect(pagesInResult("--- Page 3 ---\nfoo\n\n--- Page 4 (cont.) ---\nbar")).toEqual([3, 4]);
    expect(pagesInResult({ page: 7, text: "x" })).toEqual([7]);
    expect(pagesInResult({ page: 7, text: "" }), "an empty read carried nothing").toEqual([]);
    expect(pagesInResult({ hits: [{ page: 2 }] }), "search hits are not page text").toEqual([]);
  });
});
