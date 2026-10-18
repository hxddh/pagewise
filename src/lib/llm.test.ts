import { afterEach, describe, expect, it } from "vitest";
import { APICallError, StreamProviderError } from "ai";
import {
  formatLlmError,
  injectWebSearchPlugin,
  isImageInputError,
  setWebSearchForRun,
  takeWebSearchInjection,
  validateModel,
} from "./llm";
import { clearAgentRunAbortSignal, setAgentRunAbortSignal } from "./agent-abort";

describe("formatLlmError", () => {
  it("reads an error the provider sent after the stream began", () => {
    // OpenRouter reports an upstream failure mid-run as an error frame; the
    // raw provider message is in the same place an HTTP error body keeps it.
    const err = new StreamProviderError({
      message: "Provider returned error",
      statusCode: 502,
      isRetryable: true,
      data: { error: { message: "Provider returned error", metadata: { raw: "upstream overloaded, retry later" } } },
    });
    expect(formatLlmError(err)).toBe("upstream overloaded, retry later");
  });

  it("takes the status of a mid-stream error from the error itself", () => {
    const err = new StreamProviderError({ message: "slow down", statusCode: 429, isRetryable: true });
    expect(formatLlmError(err)).toMatch(/rate limited/i);
  });

  it("never shows a plain error object as [object Object]", () => {
    expect(formatLlmError({ error: { message: "context length exceeded" } })).toBe("context length exceeded");
  });

  it("maps OpenRouter tool-use 404 before generic notFound", () => {
    const err = new APICallError({
      message: 'No endpoints found that support tool use',
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: {},
      responseBody: "",
      isRetryable: false,
    });
    const msg = formatLlmError(err);
    expect(msg).toContain("tool");
    expect(msg).not.toContain("verify base URL");
  });

  it("maps generic Provider returned error to actionable guidance", () => {
    const msg = formatLlmError(new Error("Provider returned error"));
    expect(msg).toContain("gpt-4o-mini");
  });

  it("unwraps OpenRouter metadata.raw before generic provider message", () => {
    const err = new APICallError({
      message: "Bad Request",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 400,
      responseHeaders: {},
      responseBody: JSON.stringify({
        error: {
          message: "Provider returned error",
          metadata: { raw: "image input is not supported for this model" },
        },
      }),
      isRetryable: false,
    });
    expect(isImageInputError(err)).toBe(true);
    const agentMsg = formatLlmError(err, undefined, "agent");
    expect(agentMsg.toLowerCase()).toMatch(/screenshot|当前页/);
    const scanMsg = formatLlmError(err, undefined, "scan");
    expect(scanMsg.toLowerCase()).toContain("scan");
  });

  // (24.0) Classified by the body's code / type / message, not the status alone.
  const apiError = (url: string, statusCode: number, body: unknown) =>
    new APICallError({
      message: "error",
      url,
      requestBodyValues: {},
      statusCode,
      responseHeaders: {},
      responseBody: JSON.stringify(body),
      isRetryable: statusCode >= 429,
    });

  it("says an OpenAI insufficient_quota 429 needs a top-up, not a retry", () => {
    const err = apiError("https://api.openai.com/v1/chat/completions", 429, {
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    });
    const msg = formatLlmError(err);
    expect(msg).toContain("top up your balance at OpenAI");
    expect(msg).not.toMatch(/rate limited/i);
  });

  it("still says retry later for a genuine rate-limit 429", () => {
    const err = apiError("https://api.openai.com/v1/chat/completions", 429, {
      error: { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" },
    });
    expect(formatLlmError(err)).toMatch(/rate limited — try again/i);
  });

  it("says DeepSeek's 402 Insufficient Balance needs a top-up at DeepSeek", () => {
    const err = apiError("https://api.deepseek.com/chat/completions", 402, {
      error: { message: "Insufficient Balance", type: "unknown_error", param: null, code: "invalid_request_error" },
    });
    expect(formatLlmError(err)).toContain("top up your balance at DeepSeek");
  });

  it("says a 503 means the provider is overloaded, retry in a minute", () => {
    const err = apiError("https://api.deepseek.com/chat/completions", 503, {
      error: { message: "Server Overloaded", type: "unknown_error" },
    });
    expect(formatLlmError(err)).toMatch(/overloaded.*try again in a minute/i);
  });

  it("says an Ollama model without tool support needs another model", () => {
    const err = apiError("http://localhost:11434/v1/chat/completions", 400, {
      error: {
        message: "registry.ollama.ai/library/gemma2:2b does not support tools",
        type: "api_error",
        param: null,
        code: null,
      },
    });
    const msg = formatLlmError(err, undefined, "agent");
    expect(msg).toMatch(/can’t use tools/);
    expect(msg).toMatch(/choose a model that supports tools/);
  });

  it("recognises WebKit's 'Load failed' as a network error", () => {
    expect(formatLlmError(new TypeError("Load failed"))).toMatch(/network error — check your connection/i);
  });

  it("recognises Firefox's NetworkError as a network error", () => {
    const msg = formatLlmError(new TypeError("NetworkError when attempting to fetch resource."));
    expect(msg).toMatch(/network error/i);
  });

  it("asks whether Ollama is running when the local server is unreachable", () => {
    const err = new APICallError({
      message: "Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434",
      url: "http://localhost:11434/v1/chat/completions",
      requestBodyValues: {},
      cause: new Error("connect ECONNREFUSED 127.0.0.1:11434"),
      isRetryable: true,
    });
    expect(formatLlmError(err)).toMatch(/is Ollama running/);
  });

  it("gives a next step when the conversation exceeds the context window", () => {
    const err = apiError("https://api.openai.com/v1/chat/completions", 400, {
      error: {
        message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    });
    expect(formatLlmError(err)).toMatch(/start a new chat/);
  });

  it("keeps the body's code when the error arrives as a plain object", () => {
    const msg = formatLlmError({ error: { message: "quota", code: "insufficient_quota" } });
    expect(msg).toMatch(/top up your balance/);
  });

  it("translates the new classes", () => {
    const t = (key: string, vars?: Record<string, string | number>) =>
      `${key}${vars ? JSON.stringify(vars) : ""}`;
    const err = apiError("https://api.deepseek.com/chat/completions", 402, {
      error: { message: "Insufficient Balance" },
    });
    expect(formatLlmError(err, t)).toBe('llm.insufficientBalance{"provider":"DeepSeek"}');
  });

  it("treats OpenRouter failed image download as image input error", () => {
    const err = new Error(
      'Failed to download image from iVBORw0KGgoAAAANSUhEUgAABMgAAAYwCAYAAACHkHNS',
    );
    expect(isImageInputError(err)).toBe(true);
  });
});

describe("validateModel", () => {
  it("allows custom model ids on OpenRouter", () => {
    expect(
      validateModel({
        provider: "openrouter",
        apiKey: "sk-test",
        model: "anthropic/claude-3.5-sonnet",
      }),
    ).toBeNull();
  });
});

describe("injectWebSearchPlugin", () => {
  it("adds the OpenRouter web plugin to a chat body", () => {
    const out = JSON.parse(injectWebSearchPlugin(JSON.stringify({ model: "x", messages: [] })));
    expect(out.plugins).toEqual([{ id: "web", max_results: 3 }]);
    expect(out.model).toBe("x"); // existing fields preserved
  });

  it("appends to an existing plugins array and honors maxResults", () => {
    const out = JSON.parse(
      injectWebSearchPlugin(JSON.stringify({ plugins: [{ id: "other" }] }), 5),
    );
    expect(out.plugins).toEqual([{ id: "other" }, { id: "web", max_results: 5 }]);
  });

  it("returns a non-JSON body untouched", () => {
    expect(injectWebSearchPlugin("not json")).toBe("not json");
  });
});

describe("takeWebSearchInjection", () => {
  afterEach(() => {
    setWebSearchForRun(false);
    clearAgentRunAbortSignal();
  });

  const streamedBody = JSON.stringify({ model: "x", stream: true, messages: [] });

  it("injects once for a streamed agent request, then disarms for later steps", () => {
    setWebSearchForRun(true);
    setAgentRunAbortSignal(new AbortController().signal);

    const first = takeWebSearchInjection(streamedBody);
    expect(first).not.toBeNull();
    expect(JSON.parse(first!).plugins).toEqual([{ id: "web", max_results: 3 }]);

    // Steps 2..N carry a different body (more messages) and must not each
    // trigger another billed search.
    const step2Body = JSON.stringify({
      model: "x",
      stream: true,
      messages: [{ role: "tool", content: "…" }],
    });
    expect(takeWebSearchInjection(step2Body)).toBeNull();
  });

  it("re-injects when the SDK retries the exact same first request", () => {
    setWebSearchForRun(true);
    setAgentRunAbortSignal(new AbortController().signal);

    expect(takeWebSearchInjection(streamedBody)).not.toBeNull();
    // A transient 429/5xx makes the SDK resend an identical body — the retry
    // (the request that actually succeeds) must keep the plugin.
    const retried = takeWebSearchInjection(streamedBody);
    expect(retried).not.toBeNull();
    expect(JSON.parse(retried!).plugins).toEqual([{ id: "web", max_results: 3 }]);
  });

  it("ignores non-streamed requests (connection tests) during a web run", () => {
    setWebSearchForRun(true);
    setAgentRunAbortSignal(new AbortController().signal);
    const probe = JSON.stringify({ model: "x", messages: [{ role: "user", content: "ping" }] });
    expect(takeWebSearchInjection(probe)).toBeNull();
    // The opt-in stays armed for the actual agent request.
    expect(takeWebSearchInjection(streamedBody)).not.toBeNull();
  });

  it("does nothing outside an agent run or without the opt-in", () => {
    setWebSearchForRun(true);
    expect(takeWebSearchInjection(streamedBody)).toBeNull(); // no run signal

    setWebSearchForRun(false);
    setAgentRunAbortSignal(new AbortController().signal);
    expect(takeWebSearchInjection(streamedBody)).toBeNull(); // no opt-in
  });
});
