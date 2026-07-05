import { describe, expect, it, vi, afterEach } from "vitest";
import { docCache } from "./doc-cache";
import { markSemanticIndexDirty, clearSemanticIndex } from "./semantic-index";
import { embedTexts } from "./embeddings";

vi.mock("./settings", () => ({
  loadSettings: vi.fn(async () => ({
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-4o-mini",
  })),
}));

vi.mock("./embeddings", () => ({
  embeddingModelKey: () => "openai:text-embedding-3-small",
  embedTexts: vi.fn(async (_settings: unknown, values: string[]) =>
    values.map(() => [0.1, 0.2]),
  ),
  embedText: vi.fn(async () => [0.1, 0.2]),
  cosineSimilarity: () => 0.9,
}));

describe("ensureSemanticIndex", () => {
  afterEach(() => {
    clearSemanticIndex("/doc.pdf");
    docCache.clear();
    vi.mocked(embedTexts).mockClear();
  });

  it("rebuilds when marked dirty after an initial build", async () => {
    const path = "/doc.pdf";
    docCache.set({
      path,
      name: "doc.pdf",
      kind: "pdf",
      totalPages: 1,
      pages: [{ page: 1, text: "a".repeat(25) }],
    });

    const { ensureSemanticIndex } = await import("./semantic-index");
    await ensureSemanticIndex(path, docCache.getPages(path));
    markSemanticIndexDirty(path);
    await ensureSemanticIndex(path, docCache.getPages(path));

    expect(vi.mocked(embedTexts).mock.calls.length).toBe(2);
  });
});
