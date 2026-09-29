import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ prompt: string }> = [];
vi.mock("ai", () => ({
  generateObject: vi.fn(async (opts: { prompt: string }) => {
    calls.push(opts);
    return {
      object: { verdict: opts.prompt.includes("24 个月") ? "contradicts" : "supports", reason: "原文：三十六个月" },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }),
}));
vi.mock("./settings", () => ({ loadSettings: async () => ({ provider: "openai", model: "m", apiKey: "k" }) }));
vi.mock("./llm", () => ({ resolveModel: () => "model", assertApiKeyForAgent: () => undefined }));

import { cachedReview, clearReviews, reviewClaim, reviewPrompt, subscribeReviews } from "./claim-review";

beforeEach(() => {
  calls.length = 0;
  clearReviews();
});

describe("reviewClaim", () => {
  it("asks once per sentence and quote, and keeps the verdict", async () => {
    let told = 0;
    const off = subscribeReviews(() => (told += 1));
    const r = await reviewClaim("/a.pdf", "质保期为 24 个月", "三十六个月", "质保期为最终验收合格之日起三十六个月", 3);
    expect(r).toEqual({ verdict: "contradicts", reason: "原文：三十六个月" });
    await reviewClaim("/a.pdf", "质保期为 24 个月", "三十六个月", "…", 3);
    expect(calls).toHaveLength(1);
    expect(cachedReview("/a.pdf", "质保期为 24 个月", "三十六个月")?.verdict).toBe("contradicts");
    expect(told).toBeGreaterThan(0);
    off();
  });

  it("forgets a document's reviews when it closes", async () => {
    await reviewClaim("/a.pdf", "质保期为 36 个月", "三十六个月", "…", 3);
    clearReviews("/a.pdf");
    expect(cachedReview("/a.pdf", "质保期为 36 个月", "三十六个月")).toBeNull();
  });
});

describe("reviewPrompt", () => {
  it("gives the passage, the quote and the sentence, and decides only from the passage", () => {
    const p = reviewPrompt("质保期为 24 个月", "三十六个月", "质保期为最终验收合格之日起三十六个月", 3);
    expect(p).toContain("Decide only from the passage");
    expect(p).toContain("page 3");
    expect(p).toContain("质保期为最终验收合格之日起三十六个月");
    expect(p).toContain("质保期为 24 个月");
  });
});
