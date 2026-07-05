import { describe, expect, it } from "vitest";
import { APICallError } from "ai";
import { formatLlmError, validateModel } from "./llm";

describe("formatLlmError", () => {
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
