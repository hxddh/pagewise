import { createOpenAI } from "@ai-sdk/openai";
import { ToolLoopAgent } from "ai";
import { describe, expect, it } from "vitest";
import { systemMessageFor } from "./agent";

function capturingFetch(bodies: string[]): typeof fetch {
  return (async (_url: string, init?: { body?: unknown }) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "gpt-5.6",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  }) as unknown as typeof fetch;
}

describe("prompt cache breakpoint", () => {
  it("marks explicit promptCacheBreakpoint only for OpenAI GPT-5.6+ models", () => {
    const marked = systemMessageFor({ provider: "openai", model: "gpt-5.6" });
    expect(marked).toMatchObject({
      role: "system",
      providerOptions: { openai: { promptCacheBreakpoint: { mode: "explicit" } } },
    });

    for (const model of ["gpt-4o-mini", "gpt-4.1-mini", "gpt-4o", "gpt-5", undefined]) {
      expect(typeof systemMessageFor({ provider: "openai", model }), String(model)).toBe("string");
    }

    for (const provider of ["deepseek", "openrouter", "ollama", "custom"] as const) {
      expect(typeof systemMessageFor({ provider }), provider).toBe("string");
    }
  });

  it("attaches ephemeral cacheControl for OpenRouter Anthropic models", () => {
    const claude = systemMessageFor({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });
    expect(claude).toMatchObject({
      role: "system",
      providerOptions: {
        openrouter: { cacheControl: { type: "ephemeral" } },
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    });
  });

  it("reaches the request body for GPT-5.6+ and omits it for gpt-4o-mini", async () => {
    const bodies56: string[] = [];
    const agent56 = new ToolLoopAgent({
      model: createOpenAI({
        apiKey: "sk-test",
        baseURL: "http://127.0.0.1:9/v1",
        fetch: capturingFetch(bodies56),
      }).chat("gpt-5.6"),
      instructions: systemMessageFor({ provider: "openai", model: "gpt-5.6" }),
      tools: {},
    });
    const res56 = await agent56.stream({ prompt: "hello" });
    for await (const _ of res56.textStream) void _;
    expect(bodies56[0]).toContain('"prompt_cache_breakpoint":{"mode":"explicit"}');

    const bodies4o: string[] = [];
    const agent4o = new ToolLoopAgent({
      model: createOpenAI({
        apiKey: "sk-test",
        baseURL: "http://127.0.0.1:9/v1",
        fetch: capturingFetch(bodies4o),
      }).chat("gpt-4o-mini"),
      instructions: systemMessageFor({ provider: "openai", model: "gpt-4o-mini" }),
      tools: {},
    });
    const res4o = await agent4o.stream({ prompt: "hello" });
    for await (const _ of res4o.textStream) void _;
    expect(bodies4o[0]).not.toContain("prompt_cache_breakpoint");
  });
});
