import { describe, expect, it } from "vitest";
import { simulateReadableStream, ToolLoopAgent, type UIMessageChunk } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { PagewiseChatTransport } from "./pagewise-chat-transport";
import { clearAgentRunAbortSignal, getAgentRunAbortSignal } from "./agent-abort";

const finishUsage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 8, text: 8, reasoning: undefined },
};

async function collectMetadata(stream: ReadableStream<UIMessageChunk>): Promise<Record<string, unknown>[]> {
  const reader = stream.getReader();
  const metadata: Record<string, unknown>[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if ("messageMetadata" in value && value.messageMetadata) {
      metadata.push(value.messageMetadata as Record<string, unknown>);
    }
  }
  return metadata;
}

describe("PagewiseChatTransport", () => {
  it("tracks usage metadata from mock agent stream", async () => {
    const agent = new ToolLoopAgent({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "Hello" },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                logprobs: undefined,
                usage: finishUsage,
              },
            ],
          }),
        }),
      }),
      instructions: "test",
    });

    const transport = new PagewiseChatTransport({
      agent,
      resolveModelLabel: async () => "mock-model",
      resolveProvider: async () => "openai",
    });

    const uiStream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "test",
      messageId: undefined,
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }],
      abortSignal: new AbortController().signal,
    });

    const metadata = await collectMetadata(uiStream);
    const merged = Object.assign({}, ...metadata);

    expect(merged.finishedAt).toEqual(expect.any(Number));
    expect(merged.inputTokens).toBe(12);
    expect(merged.outputTokens).toBe(8);
    expect(merged.firstTokenAt).toEqual(expect.any(Number));
  });

  it("propagates agent stream setup errors instead of masking them", async () => {
    const agent = {
      stream: async () => {
        throw new Error("Invalid API key");
      },
      tools: {},
    } as unknown as InstanceType<typeof ToolLoopAgent>;

    const transport = new PagewiseChatTransport({
      agent,
      resolveModelLabel: async () => "mock-model",
      resolveProvider: async () => "openai",
    });

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "test",
        messageId: undefined,
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }],
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow("Invalid API key");
  });

  it("keeps agent abort signal until the UI stream finishes", async () => {
    const agent = new ToolLoopAgent({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "Hi" },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                logprobs: undefined,
                usage: finishUsage,
              },
            ],
          }),
        }),
      }),
      instructions: "test",
    });

    const transport = new PagewiseChatTransport({
      agent,
      resolveModelLabel: async () => "mock-model",
      resolveProvider: async () => "openai",
    });

    const controller = new AbortController();
    const uiStream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "test",
      messageId: undefined,
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }],
      abortSignal: controller.signal,
    });

    expect(getAgentRunAbortSignal()).toBe(controller.signal);

    const reader = uiStream.getReader();
    while (!(await reader.read()).done) {
      // drain
    }

    expect(getAgentRunAbortSignal()).toBeUndefined();
  });

  it("clears agent abort signal after stream setup errors", async () => {
    const agent = {
      stream: async () => {
        throw new Error("boom");
      },
      tools: {},
    } as unknown as InstanceType<typeof ToolLoopAgent>;

    const transport = new PagewiseChatTransport({
      agent,
      resolveModelLabel: async () => "mock-model",
      resolveProvider: async () => "openai",
    });

    const controller = new AbortController();
    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "test",
        messageId: undefined,
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] }],
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("boom");

    expect(getAgentRunAbortSignal()).toBeUndefined();
    clearAgentRunAbortSignal();
  });

  it("repairs corrupt history instead of rejecting empty assistant rows", async () => {
    const agent = new ToolLoopAgent({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "ok" },
              { type: "text-end", id: "text-1" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: undefined },
                logprobs: undefined,
                usage: finishUsage,
              },
            ],
          }),
        }),
      }),
      instructions: "test",
    });

    const transport = new PagewiseChatTransport({
      agent,
      resolveModelLabel: async () => "mock-model",
      resolveProvider: async () => "openai",
    });

    const uiStream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "test",
      messageId: undefined,
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] },
        { id: "a1", role: "assistant", parts: [] },
      ],
      abortSignal: new AbortController().signal,
    });

    const reader = uiStream.getReader();
    while (!(await reader.read()).done) {
      // drain
    }
    expect(getAgentRunAbortSignal()).toBeUndefined();
  });
});
