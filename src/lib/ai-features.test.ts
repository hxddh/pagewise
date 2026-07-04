import { describe, expect, it } from "vitest";
import { resolveDocPath } from "./agent-runtime-context";
import { cosineSimilarity } from "./embeddings";
import { resolveReasoning } from "./llm";
import { isEmbeddingCapableProvider } from "./model-capabilities";
import { pickFastModelId, shouldUseFastModelForStep } from "./model-routing";
import { normalizeStructuredCitations } from "./structured-citations";
import type { StructuredCitation } from "./structured-citations";

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

  it("returns 0 for mismatched dimensions instead of throwing", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("isEmbeddingCapableProvider", () => {
  it("recognizes providers with a known embeddings endpoint", () => {
    expect(isEmbeddingCapableProvider("openai")).toBe(true);
    expect(isEmbeddingCapableProvider("ollama")).toBe(true);
  });

  it("rejects providers without a known embeddings endpoint", () => {
    expect(isEmbeddingCapableProvider("deepseek")).toBe(false);
    expect(isEmbeddingCapableProvider("openrouter")).toBe(false);
    expect(isEmbeddingCapableProvider("custom")).toBe(false);
  });
});

describe("normalizeStructuredCitations", () => {
  const cite = (page: number, pageEnd?: number, quote = "q"): StructuredCitation =>
    pageEnd === undefined ? { page, quote } : { page, pageEnd, quote };

  it("keeps page>=1 with no upper bound when totalPages is omitted", () => {
    const out = normalizeStructuredCitations([cite(1), cite(999)]);
    expect(out.map((c) => c.page)).toEqual([1, 999]);
  });

  it("drops citations outside [1, totalPages]", () => {
    const out = normalizeStructuredCitations([cite(1), cite(5), cite(11)], 10);
    expect(out.map((c) => c.page)).toEqual([1, 5]);
    // A range that spills past the bound is dropped.
    expect(normalizeStructuredCitations([cite(8, 12)], 10)).toEqual([]);
  });

  it("normalizes inverted ranges", () => {
    const out = normalizeStructuredCitations([cite(7, 3)], 10);
    expect(out).toEqual([{ page: 3, pageEnd: 7, quote: "q" }]);
  });

  it("dedupes by page:pageEnd", () => {
    const out = normalizeStructuredCitations([cite(2), cite(2), cite(2, 4), cite(4, 2)]);
    expect(out).toEqual([
      { page: 2, quote: "q" },
      { page: 2, pageEnd: 4, quote: "q" },
    ]);
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
