import { describe, expect, it, beforeEach } from "vitest";
import type { UIMessage } from "ai";
import {
  __resetSessionStoreForTests,
  clearActiveThread,
  createThread,
  deleteThread,
  listChatSessions,
  loadActiveMessages,
  saveActiveSession,
  switchThread,
} from "./chat-sessions";

function msg(id: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

describe("saveActiveSession", () => {
  beforeEach(() => {
    __resetSessionStoreForTests({ version: 2, byPath: {} });
  });

  it("persists non-empty messages", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("1", "hello")]);
    const loaded = await loadActiveMessages("/a.pdf");
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0].parts[0]).toMatchObject({ text: "hello" });
  });

  it("does not delete history when saving empty messages", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("1", "keep me")]);
    await saveActiveSession("/a.pdf", "a.pdf", "default", []);
    const loaded = await loadActiveMessages("/a.pdf");
    expect(loaded.messages).toHaveLength(1);
  });

  it("clearActiveThread removes stored thread", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("1", "bye")]);
    await clearActiveThread("/a.pdf", "default");
    const loaded = await loadActiveMessages("/a.pdf");
    expect(loaded.messages).toHaveLength(0);
    expect(loaded.threads).toHaveLength(0);
  });
});

describe("loadActiveMessages", () => {
  beforeEach(() => {
    __resetSessionStoreForTests({ version: 2, byPath: {} });
  });

  it("loads preferred session id", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("1", "one")]);
    await saveActiveSession("/a.pdf", "a.pdf", "other", [msg("2", "two")]);
    const loaded = await loadActiveMessages("/a.pdf", "other");
    expect(loaded.sessionId).toBe("other");
    expect(loaded.messages[0].parts[0]).toMatchObject({ text: "two" });
  });

  it("does not persist a preferred session id that points at a missing thread", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("1", "one")]);
    const loaded = await loadActiveMessages("/a.pdf", "does-not-exist");
    // Falls back to the existing thread instead of the phantom preferred id.
    expect(loaded.sessionId).toBe("default");
    // A subsequent default load must still see "default" as active (nothing corrupted).
    const again = await loadActiveMessages("/a.pdf");
    expect(again.sessionId).toBe("default");
    expect(again.messages[0].parts[0]).toMatchObject({ text: "one" });
  });
});

describe("createThread / switchThread / deleteThread", () => {
  beforeEach(() => {
    __resetSessionStoreForTests({ version: 2, byPath: {} });
  });

  it("creates a new thread with Chat N naming and makes it active", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("1", "hi")]);
    const { sessionId, threads } = await createThread("/a.pdf", "a.pdf");
    expect(threads).toHaveLength(2);
    expect(threads[1].name).toBe("Chat 1");
    const loaded = await loadActiveMessages("/a.pdf");
    expect(loaded.sessionId).toBe(sessionId);
    expect(loaded.messages).toHaveLength(0);
  });

  it("switchThread returns that thread's messages and sets it active", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("1", "one")]);
    await saveActiveSession("/a.pdf", "a.pdf", "second", [msg("2", "two")]);
    const messages = await switchThread("/a.pdf", "default");
    expect(messages[0].parts[0]).toMatchObject({ text: "one" });
    const loaded = await loadActiveMessages("/a.pdf");
    expect(loaded.sessionId).toBe("default");
  });

  it("deleteThread removes a thread and reassigns active when needed", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("1", "one")]);
    await saveActiveSession("/a.pdf", "a.pdf", "second", [msg("2", "two")]);
    await deleteThread("/a.pdf", "second");
    const loaded = await loadActiveMessages("/a.pdf");
    expect(loaded.threads).toHaveLength(1);
    expect(loaded.threads[0].id).toBe("default");
  });

  it("a late save for a deleted UUID thread does not resurrect it as Default", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("1", "one")]);
    const { sessionId } = await createThread("/a.pdf", "a.pdf");
    await deleteThread("/a.pdf", sessionId);
    await deleteThread("/a.pdf", "default"); // whole doc entry now gone
    // Debounced save arrives after the doc was deleted with a UUID sessionId.
    await saveActiveSession("/a.pdf", "a.pdf", sessionId, [msg("late", "late")]);
    const loaded = await loadActiveMessages("/a.pdf");
    expect(loaded.threads).toHaveLength(0);
  });
});

describe("listChatSessions", () => {
  beforeEach(() => {
    __resetSessionStoreForTests({ version: 2, byPath: {} });
  });

  it("returns empty when there is nothing stored", async () => {
    expect(await listChatSessions()).toEqual([]);
  });

  it("filters out empty threads and sorts newest first", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("1", "older")]);
    await new Promise((r) => setTimeout(r, 2));
    await saveActiveSession("/b.pdf", "b.pdf", "default", [msg("2", "newer")]);
    // An empty thread should be excluded.
    await createThread("/a.pdf", "a.pdf");

    const sessions = await listChatSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].docPath).toBe("/b.pdf");
    expect(sessions[1].docPath).toBe("/a.pdf");
  });
});

describe("migrate / corrupt store handling", () => {
  it("migrates a legacy byPath store into v2 threads", async () => {
    __resetSessionStoreForTests({
      byPath: {
        "/leg.pdf": { docName: "leg.pdf", messages: [msg("1", "legacy")], updatedAt: 123 },
      },
    } as unknown as Parameters<typeof __resetSessionStoreForTests>[0]);

    const loaded = await loadActiveMessages("/leg.pdf");
    expect(loaded.sessionId).toBe("default");
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.messages[0].parts[0]).toMatchObject({ text: "legacy" });
  });

  it("falls back to an empty store for a corrupt v2 marker with no byPath", async () => {
    __resetSessionStoreForTests({ version: 2 } as unknown as Parameters<
      typeof __resetSessionStoreForTests
    >[0]);

    // Must not throw and must behave as empty.
    expect(await listChatSessions()).toEqual([]);
    const loaded = await loadActiveMessages("/anything.pdf");
    expect(loaded.threads).toHaveLength(0);
  });

  it("drops structurally-invalid doc entries", async () => {
    __resetSessionStoreForTests({
      version: 2,
      byPath: {
        "/bad.pdf": { docName: "bad", threads: "not-an-array" },
        "/good.pdf": {
          docName: "good",
          activeSessionId: "default",
          threads: [{ id: "default", name: "Default", messages: [msg("1", "ok")], updatedAt: 1 }],
        },
      },
    } as unknown as Parameters<typeof __resetSessionStoreForTests>[0]);

    const loaded = await loadActiveMessages("/good.pdf");
    expect(loaded.messages).toHaveLength(1);
    const bad = await loadActiveMessages("/bad.pdf");
    expect(bad.threads).toHaveLength(0);
  });
});

describe("serialized mutations", () => {
  beforeEach(() => {
    __resetSessionStoreForTests({ version: 2, byPath: {} });
  });

  it("does not drop threads when concurrent saves interleave", async () => {
    await saveActiveSession("/a.pdf", "a.pdf", "default", [msg("d", "base")]);
    // Two concurrent saves adding distinct threads to the same doc. Serialized
    // read-modify-write must keep both.
    await Promise.all([
      saveActiveSession("/a.pdf", "a.pdf", "s1", [msg("1", "one")]),
      saveActiveSession("/a.pdf", "a.pdf", "s2", [msg("2", "two")]),
    ]);
    const loaded = await loadActiveMessages("/a.pdf");
    const ids = loaded.threads.map((t) => t.id).sort();
    expect(ids).toEqual(["default", "s1", "s2"]);
  });
});
