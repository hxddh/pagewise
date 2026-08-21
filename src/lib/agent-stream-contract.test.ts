import { describe, expect, it } from "vitest";
import { simulateReadableStream, ToolLoopAgent, tool, type UIMessageChunk } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { PagewiseChatTransport } from "./pagewise-chat-transport";
import { getAgentRunAbortSignal } from "./agent-abort";

const finishUsage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 8, text: 8, reasoning: undefined },
} as never;

/**
 * A model that calls one tool, then answers — the shape of nearly every real
 * run. The provider is faked at the model boundary, so everything from the tool
 * loop inward is the real code path.
 */
function twoStepAgent() {
  let step = 0;
  return new ToolLoopAgent({
    model: new MockLanguageModelV4({
      doStream: async () => {
        step += 1;
        const chunks =
          step === 1
            ? [
                { type: "tool-input-start", id: "c1", toolName: "echo" },
                { type: "tool-input-delta", id: "c1", delta: '{"n":3}' },
                { type: "tool-input-end", id: "c1" },
                { type: "tool-call", toolCallId: "c1", toolName: "echo", input: '{"n":3}' },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: undefined },
                  logprobs: undefined,
                  usage: finishUsage,
                },
              ]
            : [
                { type: "text-start", id: "t1" },
                { type: "text-delta", id: "t1", delta: "Page 3 defines it." },
                { type: "text-end", id: "t1" },
                {
                  type: "finish",
                  finishReason: { unified: "stop", raw: undefined },
                  logprobs: undefined,
                  usage: finishUsage,
                },
              ];
        return { stream: simulateReadableStream({ chunks: chunks as never }) };
      },
    }),
    instructions: "test",
    tools: {
      echo: tool({
        description: "echo",
        inputSchema: z.object({ n: z.number() }),
        execute: async ({ n }) => ({ got: n }),
      }),
    },
  });
}

function transportFor(agent: ReturnType<typeof twoStepAgent>) {
  return new PagewiseChatTransport({
    agent,
    resolveModelLabel: async () => "mock-model",
    resolveProvider: async () => "openai",
  });
}

/** Drain the UI stream, recording every chunk. `onChunk` can abort mid-run. */
async function drain(
  stream: ReadableStream<UIMessageChunk>,
  onChunk?: (chunk: UIMessageChunk) => void,
): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onChunk?.(value);
  }
  return chunks;
}

/**
 * The run's shape: metadata dropped, then runs of one type collapsed.
 *
 * In that order. Metadata interleaves between text deltas, so collapsing first
 * leaves two adjacent `text-delta` behind once it is filtered out — and how
 * many deltas a reveal emits is an implementation detail, not a contract.
 */
function skeleton(chunks: UIMessageChunk[]): string[] {
  const out: string[] = [];
  for (const c of chunks) {
    if (c.type === "message-metadata") continue;
    if (out[out.length - 1] !== c.type) out.push(c.type);
  }
  return out;
}

/**
 * The order of what reaches the UI during a run.
 *
 * The existing transport tests cover usage metadata, setup errors, the abort
 * SIGNAL's lifetime, and history repair — each a property of one chunk or one
 * variable. None of them look at the SEQUENCE, and the sequence is what a
 * reader actually experiences: a tool step appearing before its result, an
 * answer that starts before the tool it depends on has returned, or a stopped
 * run that still reports itself finished.
 *
 * This is also the objective record for any change to how the request is made —
 * a different base URL, a proxy in front of the provider, a new transport. Such
 * a change is supposed to alter nothing here. Without a recording of what "here"
 * is, "streaming still works" is an opinion.
 */
describe("what a run streams to the UI", () => {
  it("puts the tool call and its result before the answer", async () => {
    const chunks = await drain(
      (await transportFor(twoStepAgent()).sendMessages({
        trigger: "submit-message",
        chatId: "t",
        messageId: undefined,
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }],
        abortSignal: new AbortController().signal,
      } as never)) as ReadableStream<UIMessageChunk>,
    );

    // Metadata rides alongside and is asserted separately below; the run's own
    // shape is what this pins.
    expect(skeleton(chunks)).toEqual([
      "start",
      "start-step",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-available",
      "tool-output-available",
      "finish-step",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
  });

  it("never starts the answer before the tool it called has returned", async () => {
    // The ordering the list above encodes, stated as the property it exists
    // for — so a reordering that keeps every event but moves one still fails.
    const chunks = await drain(
      (await transportFor(twoStepAgent()).sendMessages({
        trigger: "submit-message",
        chatId: "t",
        messageId: undefined,
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }],
        abortSignal: new AbortController().signal,
      } as never)) as ReadableStream<UIMessageChunk>,
    );
    const at = (type: string) => chunks.findIndex((c) => c.type === type);

    expect(at("tool-input-available")).toBeLessThan(at("tool-output-available"));
    expect(at("tool-output-available")).toBeLessThan(at("text-start"));
    expect(at("start")).toBe(0);
    expect(at("finish")).toBe(chunks.length - 1);
  });

  it("reveals the answer in pieces rather than in one lump", async () => {
    // The exact number of deltas is an implementation detail of the reveal, but
    // that there is MORE THAN ONE is the feature: the model sent a single
    // delta and the transform is what turns it into text that appears as it is
    // written. Dropping `experimental_transform` passes every other assertion
    // here — the sequence is identical — and the reader watches the answer
    // arrive all at once.
    const chunks = await drain(
      (await transportFor(twoStepAgent()).sendMessages({
        trigger: "submit-message",
        chatId: "t",
        messageId: undefined,
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }],
        abortSignal: new AbortController().signal,
      } as never)) as ReadableStream<UIMessageChunk>,
    );
    const deltas = chunks.filter((c) => c.type === "text-delta");
    expect(deltas.length, "one model delta must reach the UI as several").toBeGreaterThan(1);
    expect(
      deltas.map((c) => (c as { delta: string }).delta).join(""),
      "and the pieces must reassemble into exactly what was sent",
    ).toBe("Page 3 defines it.");
  });

  it("reports the first token before it reports the last", async () => {
    // Both numbers reach the UI as message metadata. firstTokenAt is what the
    // reader sees as "it started"; finishedAt is the whole run. Getting them the
    // wrong way round would report negative thinking time.
    const chunks = await drain(
      (await transportFor(twoStepAgent()).sendMessages({
        trigger: "submit-message",
        chatId: "t",
        messageId: undefined,
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }],
        abortSignal: new AbortController().signal,
      } as never)) as ReadableStream<UIMessageChunk>,
    );
    const merged = Object.assign(
      {},
      ...chunks
        .filter((c): c is UIMessageChunk & { messageMetadata: Record<string, unknown> } =>
          "messageMetadata" in c && !!c.messageMetadata,
        )
        .map((c) => c.messageMetadata),
    ) as { firstTokenAt: number; finishedAt: number };

    expect(merged.firstTokenAt).toEqual(expect.any(Number));
    expect(merged.finishedAt).toBeGreaterThanOrEqual(merged.firstTokenAt);
  });

  it("ends a stopped run with abort, not with finish", async () => {
    // The reader pressed stop. If the stream still closed with `finish` the UI
    // would file a half-written answer as a completed one, with usage metadata
    // for a run that never reached its end.
    const stop = new AbortController();
    const chunks = await drain(
      (await transportFor(twoStepAgent()).sendMessages({
        trigger: "submit-message",
        chatId: "t",
        messageId: undefined,
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }],
        abortSignal: stop.signal,
      } as never)) as ReadableStream<UIMessageChunk>,
      // Stop the moment the tool result lands — mid-run, before the answer.
      (chunk) => {
        if (chunk.type === "tool-output-available") stop.abort();
      },
    );

    expect(skeleton(chunks)).toEqual([
      "start",
      "start-step",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-available",
      "tool-output-available",
      "abort",
    ]);
    expect(
      chunks.some((c) => c.type === "finish"),
      "a run the reader stopped has not finished",
    ).toBe(false);
    expect(
      chunks.some((c) => c.type === "text-delta"),
      "the answer never started",
    ).toBe(false);
    // And the run's signal is released, or the next question inherits a signal
    // that is already aborted and cannot run at all.
    expect(getAgentRunAbortSignal()).toBeUndefined();
  });
});
