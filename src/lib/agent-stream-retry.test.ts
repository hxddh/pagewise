import { describe, expect, it } from "vitest";
import { simulateReadableStream, ToolLoopAgent } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { STREAM_RETRIES } from "./agent";

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
} as never;

/**
 * A provider error after the stream started reruns the step (AI SDK 7.0.91),
 * provided the setting reaches `streamText`. `agent.ts` passes it through a
 * spread because `ToolLoopAgentSettings` does not declare it; this is the
 * check that the spread is not silently dropped.
 */
describe("stream retries", () => {
  it("reruns a step whose stream failed partway, instead of failing the run", async () => {
    let calls = 0;
    const agent = new ToolLoopAgent({
      model: new MockLanguageModelV4({
        doStream: async () => {
          calls += 1;
          const chunks =
            calls === 1
              ? [
                  { type: "text-start", id: "t" },
                  { type: "text-delta", id: "t", delta: "Half an ans" },
                  { type: "error", error: { message: "upstream overloaded" } },
                ]
              : [
                  { type: "text-start", id: "t" },
                  { type: "text-delta", id: "t", delta: "The whole answer." },
                  { type: "text-end", id: "t" },
                  { type: "finish", finishReason: { unified: "stop", raw: undefined }, logprobs: undefined, usage },
                ];
          return { stream: simulateReadableStream({ chunks: chunks as never }) };
        },
      }),
      instructions: "test",
      ...({ streamRetries: STREAM_RETRIES } as object),
    });
    const result = await agent.stream({ prompt: "q" });
    let text = "";
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") text += part.text;
      if (part.type === "error") throw new Error("the run failed instead of retrying");
    }
    expect(calls).toBe(2);
    expect(text).toContain("The whole answer.");
  });
});
