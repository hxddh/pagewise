import { describe, expect, it } from "vitest";
import { isKnownNonVisionModel, isVisionModel } from "./model-capabilities";

describe("isVisionModel", () => {
  it("allows unknown multimodal ids on OpenRouter", () => {
    expect(isVisionModel("openrouter", "anthropic/claude-3.5-sonnet")).toBe(true);
  });

  it("rejects known non-vision DeepSeek models", () => {
    expect(isVisionModel("deepseek", "deepseek-v4-flash")).toBe(false);
  });

  it("marks known non-vision models", () => {
    expect(isKnownNonVisionModel("deepseek-v4-flash")).toBe(true);
    expect(isKnownNonVisionModel("anthropic/claude-3.5-sonnet")).toBe(false);
  });
});
