import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory Store double: preserves insertion order like the real plugin.
const store = new Map<string, unknown>();

vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: async () => ({
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      keys: async () => [...store.keys()],
      save: async () => {},
    }),
  },
}));

// hydrate path pulls in settings; not needed for the prune tests.
vi.mock("../lib/messages-utils", () => ({
  hydrateChatMessages: async (m: unknown) => m,
  normalizeUIMessages: (m: unknown) => (Array.isArray(m) ? m : []),
}));
vi.mock("../lib/persist-messages", () => ({
  prepareMessagesForPersist: (m: unknown) => m,
}));

describe("pruneOrphanedChats", () => {
  beforeEach(() => {
    store.clear();
    vi.resetModules();
  });

  it("does nothing while under the cap — chats for non-recent docs survive", async () => {
    for (let i = 0; i < 20; i++) store.set(`/doc-${i}.pdf`, [{ id: "m" }]);
    const { pruneOrphanedChats } = await import("./persist");
    // Only 2 recents, but 20 chats < cap → nothing pruned (N1 regression guard).
    await pruneOrphanedChats(["/doc-0.pdf", "/doc-1.pdf"], 100);
    expect(store.size).toBe(20);
  });

  it("trims oldest non-recent chats down to the cap, always keeping recents", async () => {
    for (let i = 0; i < 12; i++) store.set(`/doc-${i}.pdf`, [{ id: "m" }]);
    const { pruneOrphanedChats } = await import("./persist");
    // Cap 8: must drop 4. Keep recents (the two NEWEST) even though they're
    // last in insertion order; drop the 4 oldest non-recent keys.
    await pruneOrphanedChats(["/doc-10.pdf", "/doc-11.pdf"], 8);
    expect(store.size).toBe(8);
    expect(store.has("/doc-10.pdf")).toBe(true);
    expect(store.has("/doc-11.pdf")).toBe(true);
    // Oldest four dropped.
    expect(store.has("/doc-0.pdf")).toBe(false);
    expect(store.has("/doc-3.pdf")).toBe(false);
    expect(store.has("/doc-4.pdf")).toBe(true);
  });

  it("never drops a recent even if the store is all recents over the cap", async () => {
    for (let i = 0; i < 5; i++) store.set(`/r-${i}.pdf`, [{ id: "m" }]);
    const { pruneOrphanedChats } = await import("./persist");
    const recents = ["/r-0.pdf", "/r-1.pdf", "/r-2.pdf", "/r-3.pdf", "/r-4.pdf"];
    await pruneOrphanedChats(recents, 2);
    // Nothing is droppable (all recent) → store untouched despite exceeding cap.
    expect(store.size).toBe(5);
  });
});
