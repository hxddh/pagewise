import { describe, expect, it } from "vitest";
import { APICallError } from "ai";
import {
  formatLlmError,
  injectWebSearchPlugin,
  isImageInputError,
  validateModel,
} from "./llm";

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
