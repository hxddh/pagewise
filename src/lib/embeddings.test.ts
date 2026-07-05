import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmSettings } from "./types";

const embedManyMock = vi.fn();
const embedMock = vi.fn();

vi.mock("ai", () => ({
  embedMany: (...args: unknown[]) => embedManyMock(...args),
  embed: (...args: unknown[]) => embedMock(...args),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({ embedding: (id: string) => ({ modelId: id }) }),
}));

vi.mock("./llm", () => ({
  resolveBaseURL: () => "https://api.openai.com/v1",
}));

import { EMBED_BATCH_SIZE, embedTexts } from "./embeddings";

const openai: LlmSettings = {
  provider: "openai",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
};

const deepseek: LlmSettings = {
  provider: "deepseek",
  apiKey: "sk-test",
  model: "deepseek-v4-flash",
};

/** Resolve embedMany with `n` unit vectors of the given dimensionality. */
function vectors(n: number, dim = 3): { embeddings: number[][] } {
  return { embeddings: Array.from({ length: n }, () => Array(dim).fill(1)) };
}

beforeEach(() => {
  embedManyMock.mockReset();
  embedMock.mockReset();
});

describe("embedTexts", () => {
  it("skips providers with no embeddings endpoint (all null, no request)", async () => {
    const out = await embedTexts(deepseek, ["a", "b", "c"]);
    expect(out.embeddings).toEqual([null, null, null]);
    expect(out.capped).toBe(false);
    expect(embedManyMock).not.toHaveBeenCalled();
  });

  it("returns a same-length array with null holes for blank inputs", async () => {
    embedManyMock.mockImplementation(async ({ values }: { values: string[] }) =>
      vectors(values.length),
    );
    const out = await embedTexts(openai, ["hello", "  ", "world"]);
    expect(out.embeddings).toHaveLength(3);
    expect(out.embeddings[0]).not.toBeNull();
    expect(out.embeddings[1]).toBeNull();
    expect(out.embeddings[2]).not.toBeNull();
  });

  it("chunks into batches and isolates a failed batch", async () => {
    // 3 batches of 64/64/2. Fail the middle batch only.
    let call = 0;
    embedManyMock.mockImplementation(async ({ values }: { values: string[] }) => {
      call += 1;
      if (call === 2) throw new Error("boom");
      return vectors(values.length);
    });

    const texts = Array.from({ length: 130 }, (_, i) => `page ${i}`);
    const out = await embedTexts(openai, texts, { maxPages: 200 });

    expect(embedManyMock).toHaveBeenCalledTimes(3);
    expect(out.embeddings).toHaveLength(130);
    // Batch 1 (0..63) succeeded.
    expect(out.embeddings[0]).not.toBeNull();
    expect(out.embeddings[EMBED_BATCH_SIZE - 1]).not.toBeNull();
    // Batch 2 (64..127) nulled by isolation.
    expect(out.embeddings[EMBED_BATCH_SIZE]).toBeNull();
    expect(out.embeddings[127]).toBeNull();
    // Batch 3 (128..129) succeeded.
    expect(out.embeddings[128]).not.toBeNull();
    expect(out.embeddings[129]).not.toBeNull();
  });

  it("caps embedded pages at maxPages and nulls the rest", async () => {
    embedManyMock.mockImplementation(async ({ values }: { values: string[] }) =>
      vectors(values.length),
    );
    const texts = Array.from({ length: 120 }, (_, i) => `page ${i}`);
    const out = await embedTexts(openai, texts, { maxPages: 50 });

    expect(out.embeddings).toHaveLength(120);
    expect(out.embeddings.filter((v) => v !== null)).toHaveLength(50);
    expect(out.embeddings[49]).not.toBeNull();
    expect(out.embeddings[50]).toBeNull();
    expect(out.capped).toBe(true);
    expect(out.eligible).toBe(120);
    expect(out.embedded).toBe(50);
  });

  it("retries once on a rate limit then succeeds", async () => {
    let call = 0;
    embedManyMock.mockImplementation(async ({ values }: { values: string[] }) => {
      call += 1;
      if (call === 1) throw new Error("429 Too Many Requests");
      return vectors(values.length);
    });

    const out = await embedTexts(openai, ["a", "b"]);
    expect(embedManyMock).toHaveBeenCalledTimes(2);
    expect(out.embeddings[0]).not.toBeNull();
    expect(out.embeddings[1]).not.toBeNull();
  });

  it("honors an already-aborted signal (no requests, all null)", async () => {
    embedManyMock.mockImplementation(async ({ values }: { values: string[] }) =>
      vectors(values.length),
    );
    const controller = new AbortController();
    controller.abort();
    const out = await embedTexts(openai, ["a", "b"], { signal: controller.signal });
    expect(embedManyMock).not.toHaveBeenCalled();
    expect(out.embeddings).toEqual([null, null]);
  });
});
