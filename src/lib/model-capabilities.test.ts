import { describe, expect, it } from "vitest";
import {
  isAgentMultimodalModel,
  isKnownNonVisionModel,
  isVisionModel,
} from "./model-capabilities";

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

describe("isAgentMultimodalModel", () => {
  it("allows known vision+tools presets only", () => {
    expect(isAgentMultimodalModel("openrouter", "openai/gpt-4o-mini")).toBe(true);
    expect(isAgentMultimodalModel("openrouter", "google/gemini-2.5-flash-lite")).toBe(
      true,
    );
  });

  it("rejects unknown OpenRouter routes even when isVisionModel is optimistic", () => {
    expect(isVisionModel("openrouter", "vendor/unknown-multimodal-v9")).toBe(true);
    expect(isAgentMultimodalModel("openrouter", "vendor/unknown-multimodal-v9")).toBe(
      false,
    );
    expect(isAgentMultimodalModel("openrouter", "deepseek/deepseek-v4-flash")).toBe(
      false,
    );
    expect(isAgentMultimodalModel("openrouter", "anthropic/claude-3.5-sonnet")).toBe(
      true,
    );
  });

  it("rejects vision-only models without tool calling", () => {
    expect(isAgentMultimodalModel("openrouter", "qwen/qwen2.5-vl-72b-instruct")).toBe(
      false,
    );
  });
});
