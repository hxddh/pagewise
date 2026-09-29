import { describe, expect, it, vi } from "vitest";

/**
 * A renamed scan keeps the pages already paid for (13.0).
 *
 * 12.0 taught the marks, the record and the chat to follow a file to its new
 * name by content fingerprint. The vision cache — the one store whose loss
 * costs the reader money — was keyed on path alone, so renaming a scan
 * re-billed every page of it.
 */
const h = vi.hoisted(() => ({ saved: undefined as unknown }));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get() {
      return h.saved;
    }
    async set(_key: string, value: unknown) {
      h.saved = value;
    }
    async save() {}
  },
}));

const { loadIndexedPages } = await import("./index-store");

const text = (n: number) => `page ${n} ${"x".repeat(60)}`;

function seed(identity?: string) {
  h.saved = {
    version: 1,
    docs: [
      {
        path: "/old/scan.pdf",
        ...(identity ? { identity } : {}),
        stamp: "s1",
        totalPages: 2,
        savedAt: 1,
        pages: [
          { page: 1, text: text(1) },
          { page: 2, text: text(2) },
        ],
      },
    ],
  };
}

describe("loadIndexedPages across a rename", () => {
  it("finds a moved file's pages by fingerprint and re-keys them to its new path", async () => {
    seed("fp-abc");
    const pages = await loadIndexedPages("/new/renamed.pdf", "s1", "fp-abc");
    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    const docs = (h.saved as { docs: Array<{ path: string }> }).docs;
    expect(docs.map((d) => d.path)).toEqual(["/new/renamed.pdf"]);
  });

  it("does not match a different file", async () => {
    seed("fp-abc");
    expect(await loadIndexedPages("/new/other.pdf", "s1", "fp-zzz")).toEqual([]);
  });

  it("does not match an entry written before fingerprints were stored", async () => {
    seed();
    expect(await loadIndexedPages("/new/renamed.pdf", "s1", "fp-abc")).toEqual([]);
  });

  it("still serves the same path as before", async () => {
    seed("fp-abc");
    expect(await loadIndexedPages("/old/scan.pdf", "s1", "fp-abc")).toHaveLength(2);
  });
});
