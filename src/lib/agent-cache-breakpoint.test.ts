import { createOpenAI } from "@ai-sdk/openai";
import { ToolLoopAgent } from "ai";
import { describe, expect, it } from "vitest";
import { systemMessageFor } from "./agent";

/**
 * The cache hint: what the app sends so the fixed prefix is explicitly cached.
 *
 * The prefix — the system prompt and the eight tool definitions — is re-sent on
 * every step of every run, and the provider caches a byte-identical prefix
 * automatically. `promptCacheBreakpoint` is the request saying which block to
 * keep, so its two failure modes are both silent: not sending it, and sending
 * it in a place the SDK drops. This covers both.
 */

/** A fetch that records request bodies and answers like a chat completion stream. */
function capturingFetch(bodies: string[]): typeof fetch {
  return (async (_url: string, init?: { body?: unknown }) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "gpt-4o-mini",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }) as unknown as typeof fetch;
}

describe("prompt cache breakpoint", () => {
  it("marks the system message for OpenAI, and only for OpenAI", () => {
    const marked = systemMessageFor({ provider: "openai" });
    expect(marked).toMatchObject({
      role: "system",
      providerOptions: { openai: { promptCacheBreakpoint: { mode: "explicit" } } },
    });

    // The field is OpenAI's Chat Completions extension. The other providers this
    // app speaks to implement that API without it, so they get the plain string.
    for (const provider of ["deepseek", "openrouter", "ollama", "custom"] as const) {
      expect(typeof systemMessageFor({ provider }), provider).toBe("string");
    }
  });

  it("reaches the request body through the call shape the agent uses", async () => {
    const bodies: string[] = [];
    const agent = new ToolLoopAgent({
      model: createOpenAI({
        apiKey: "sk-test",
        baseURL: "http://127.0.0.1:9/v1",
        fetch: capturingFetch(bodies),
      }).chat("gpt-4o-mini"),
      // `instructions` is where `prepareCall` hands the marked message over.
      instructions: systemMessageFor({ provider: "openai" }),
      tools: {},
    });

    const result = await agent.stream({ prompt: "hello" });
    for await (const _ of result.textStream) void _;

    expect(bodies.length, "the run must have sent a request").toBeGreaterThan(0);
    expect(bodies[0]).toContain('"prompt_cache_breakpoint":{"mode":"explicit"}');
  });
});
