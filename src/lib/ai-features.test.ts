import { describe, expect, it } from "vitest";
import { resolveDocPath } from "./agent-runtime-context";
import { cosineSimilarity } from "./embeddings";
import { resolveReasoning } from "./llm";
import { pickFastModelId, shouldUseFastModelForStep } from "./model-routing";

describe("agent-runtime-context", () => {
  it("uses default path when input is empty", () => {
    expect(resolveDocPath(undefined, "/docs/a.pdf")).toBe("/docs/a.pdf");
  });

  it("throws when no path available", () => {
    expect(() => resolveDocPath("", null)).toThrow(/document path is required/);
  });
});

describe("model-routing", () => {
  it("picks a faster model for pro tiers", () => {
    expect(
      pickFastModelId({
        provider: "openai",
        apiKey: "x",
        model: "gpt-4o",
      }),
    ).toBe("gpt-4o-mini");
  });

  it("skips fast routing for already-mini models", () => {
    expect(
      pickFastModelId({
        provider: "openai",
        apiKey: "x",
        model: "gpt-4o-mini",
      }),
    ).toBeNull();
  });

  it("routes intermediate tool steps to fast model", () => {
    expect(
      shouldUseFastModelForStep(2, [{ toolCalls: [{}], text: "" }]),
    ).toBe(true);
    expect(shouldUseFastModelForStep(1, [{ toolCalls: [{}], text: "done" }])).toBe(
      false,
    );
  });
});

describe("embeddings", () => {
  it("computes cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

describe("resolveReasoning", () => {
  it("omits reasoning when thinking is off", () => {
    expect(
      resolveReasoning({
        provider: "openai",
        apiKey: "x",
        model: "gpt-4o",
        thinkingEnabled: false,
      }),
    ).toBeUndefined();
  });

  it("uses high reasoning for pro models when thinking is on", () => {
    expect(
      resolveReasoning({
        provider: "openrouter",
        apiKey: "x",
        model: "anthropic/claude-opus-4",
        thinkingEnabled: true,
      }),
    ).toBe("high");
  });
});
