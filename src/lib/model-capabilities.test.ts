import { describe, expect, it } from "vitest";
import {
  isAgentMultimodalModel,
  canSeeWith,
  isKnownNonVisionModel,
  isToolModel,
  isVisionModel,
} from "./model-capabilities";

describe("isVisionModel", () => {
  it("allows known multimodal ids on OpenRouter", () => {
    expect(isVisionModel("openrouter", "anthropic/claude-3.5-sonnet")).toBe(true);
  });

  it("rejects unknown OpenRouter ids without vision hints", () => {
    expect(isVisionModel("openrouter", "vendor/unknown-v9")).toBe(false);
  });

  it("allows unknown Ollama ids with vision family hints", () => {
    expect(isVisionModel("ollama", "llava:latest")).toBe(true);
  });

  it("rejects known non-vision DeepSeek models", () => {
    expect(isVisionModel("deepseek", "deepseek-v4-flash")).toBe(false);
  });

  it("marks known non-vision models", () => {
    expect(isKnownNonVisionModel("deepseek-v4-flash")).toBe(true);
    expect(isKnownNonVisionModel("anthropic/claude-3.5-sonnet")).toBe(false);
  });

  it("rejects custom provider without a scan model id", () => {
    expect(isVisionModel("custom", "")).toBe(false);
    expect(isVisionModel("custom", "my-vision-model")).toBe(true);
  });
});

describe("isAgentMultimodalModel", () => {
  it("never attaches page screenshots on OpenRouter (AI SDK base64 encoding breaks)", () => {
    expect(isAgentMultimodalModel("openrouter", "openai/gpt-4o-mini")).toBe(false);
    expect(isAgentMultimodalModel("openrouter", "google/gemini-2.5-flash-lite")).toBe(
      false,
    );
    expect(isAgentMultimodalModel("openrouter", "anthropic/claude-3.5-sonnet")).toBe(
      false,
    );
  });

  it("allows OpenAI direct multimodal agent models", () => {
    expect(isAgentMultimodalModel("openai", "gpt-4o-mini")).toBe(true);
  });

  it("rejects unknown OpenRouter routes even when name sounds multimodal", () => {
    expect(isVisionModel("openrouter", "vendor/unknown-multimodal-v9")).toBe(false);
    expect(isAgentMultimodalModel("openrouter", "vendor/unknown-multimodal-v9")).toBe(
      false,
    );
    expect(isAgentMultimodalModel("openrouter", "deepseek/deepseek-v4-flash")).toBe(
      false,
    );
    expect(isAgentMultimodalModel("openrouter", "anthropic/claude-3.5-sonnet")).toBe(
      false,
    );
  });

  it("rejects vision-only models without tool calling", () => {
    expect(isAgentMultimodalModel("openrouter", "qwen/qwen2.5-vl-72b-instruct")).toBe(
      false,
    );
  });
});

describe("isToolModel", () => {
  it("rejects unknown OpenRouter models without tool hints", () => {
    expect(isToolModel("openrouter", "vendor/unknown-v9")).toBe(false);
  });

  it("allows unknown OpenRouter models that look tool-capable", () => {
    expect(isToolModel("openrouter", "openai/gpt-4.1")).toBe(true);
    expect(isToolModel("openrouter", "anthropic/claude-sonnet-4")).toBe(true);
  });

  it("recognizes newer tool-capable OpenRouter routes (grok/kimi/glm/llama-4/nova)", () => {
    expect(isToolModel("openrouter", "x-ai/grok-4")).toBe(true);
    expect(isToolModel("openrouter", "moonshotai/kimi-k2")).toBe(true);
    expect(isToolModel("openrouter", "z-ai/glm-4.6")).toBe(true);
    expect(isToolModel("openrouter", "meta-llama/llama-4-maverick")).toBe(true);
    expect(isToolModel("openrouter", "amazon/nova-pro-v1")).toBe(true);
  });

  it("rejects unknown OpenRouter vision-only routes", () => {
    expect(isToolModel("openrouter", "vendor/unknown-vl-9")).toBe(false);
  });

  it("allows unknown Ollama models", () => {
    expect(isToolModel("ollama", "some-new-model")).toBe(true);
  });

  it("allows unknown custom models", () => {
    expect(isToolModel("custom", "my-local-agent")).toBe(true);
  });
});

describe("a model that can see is not stopped at the gate (21.1.2)", () => {
  it("lets the multimodal members of text-only families through", () => {
    for (const m of ["qwen3-vl:8b", "qwen3-vl", "mistral-small3.1", "mistral-small3.2:24b", "qwen2.5vl:7b", "llama3.2-vision", "gemma3:4b", "minicpm-v"]) {
      expect(canSeeWith(m), m).toBe(true);
    }
  });

  it("still stops the models that cannot", () => {
    for (const m of ["deepseek-v4-flash", "qwen3:8b", "mistral:7b", "llama3.1", "qwen2.5:14b"]) {
      expect(canSeeWith(m), m).toBe(false);
    }
  });
});
