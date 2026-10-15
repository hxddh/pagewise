import { beforeEach, describe, expect, it } from "vitest";

import { createAtomicStore, StoreUnreadableError, __setStoreBackendForTests } from "./atomic-store";
import { unreadableStores, __resetStoreHealthForTests } from "./store-health";
import { createMemoryStoreBackend, useMemoryStoreBackend } from "./store-testkit";

/**
 * The store file layer.
 *
 * Everything here is about the two failures the 20.0 review measured on the
 * store plugin: `save()` was `create_dir_all` + pretty JSON + `fs::write`, so a
 * crash in the middle of it left a file that read back as an *empty* store; and
 * its load error was swallowed (`let _ = store_inner.load()`), so a file that
 * could not be read was indistinguishable from one that is empty — and the next
 * save wrote the emptiness over it. The reader's marks, findings and chats are
 * the files this protects.
 */
const store = useMemoryStoreBackend();

beforeEach(() => {
  store.reset();
  __resetStoreHealthForTests();
});

describe("atomic store", () => {
  it("reads the file format the store plugin wrote", async () => {
    // What the old writer left on disk: one JSON object, pretty-printed.
    store.seed("marks.json", '{\n  "marks": {\n    "version": 2,\n    "docs": []\n  }\n}');
    const marks = createAtomicStore("marks.json");
    expect(await marks.get("marks")).toEqual({ version: 2, docs: [] });
  });

  it("reads a missing file as empty, and creates it on the first save", async () => {
    const prefs = createAtomicStore("preferences.json");
    expect(await prefs.get("prefs")).toBeUndefined();
    expect(store.files.has("preferences.json")).toBe(false);
    await prefs.set("prefs", { theme: "paper" });
    await prefs.save();
    expect(store.peek("preferences.json")).toEqual({ prefs: { theme: "paper" } });
  });

  it("writes the whole file on every save, in the readable pretty form", async () => {
    const s = createAtomicStore("recent.json");
    await s.set("files", [{ path: "/a.pdf" }]);
    await s.save();
    expect(store.files.get("recent.json")).toBe(
      '{\n  "files": [\n    {\n      "path": "/a.pdf"\n    }\n  ]\n}\n',
    );
  });

  it("refuses a file it cannot parse, on every operation, without touching it", async () => {
    // A torn write: half a JSON document.
    const torn = '{\n  "marks": {\n    "version": 2,\n    "docs": [{"pa';
    store.seed("marks.json", torn);
    const marks = createAtomicStore("marks.json");

    await expect(marks.get("marks")).rejects.toBeInstanceOf(StoreUnreadableError);
    await expect(marks.set("marks", { version: 2, docs: [] })).rejects.toBeInstanceOf(
      StoreUnreadableError,
    );
    await expect(marks.save()).rejects.toBeInstanceOf(StoreUnreadableError);
    // The bytes on disk are exactly what they were.
    expect(store.files.get("marks.json")).toBe(torn);
    expect(store.writes).toEqual([]);
  });

  it("reads a JSON array as unreadable rather than as a store", async () => {
    store.seed("recent.json", "[1, 2, 3]");
    const s = createAtomicStore("recent.json");
    await expect(s.get("files")).rejects.toBeInstanceOf(StoreUnreadableError);
  });

  it("reads again once the file is readable, and stops reporting it", async () => {
    store.seed("recent.json", "not json");
    const s = createAtomicStore("recent.json");
    await expect(s.get("files")).rejects.toBeInstanceOf(StoreUnreadableError);
    expect(unreadableStores().map((u) => u.file)).toEqual(["recent.json"]);

    // The reader moved the file aside and the app wrote a new one.
    store.seed("recent.json", '{"files": []}');
    expect(await s.get("files")).toEqual([]);
    expect(unreadableStores()).toEqual([]);
  });

  it("keeps a change the disk refused, and writes it on the next save", async () => {
    const s = createAtomicStore("recent.json");
    await s.set("files", [{ path: "/a.pdf" }]);
    store.failNextWrite();
    await expect(s.save()).rejects.toThrow("disk full");
    expect(store.files.has("recent.json")).toBe(false);
    await s.save();
    expect(store.peek("recent.json")).toEqual({ files: [{ path: "/a.pdf" }] });
  });

  it("tells the app which file it could not read, once", async () => {
    store.seed("findings.json", "{oops");
    const s = createAtomicStore("findings.json");
    const seen: string[] = [];
    const { subscribeStoreUnreadable } = await import("./store-health");
    const unsubscribe = subscribeStoreUnreadable((entry) => seen.push(entry.file));
    await s.get("findings").catch(() => {});
    await s.get("findings").catch(() => {});
    unsubscribe();
    expect(seen).toEqual(["findings.json"]);
    expect(unreadableStores()[0]?.message).toContain("findings.json");
  });

  it("goes back to the Tauri commands when the test backend is removed", async () => {
    // Not a call into Tauri — just that the seam is a seam, and the default is
    // the real one (which throws here, since there is no Tauri runtime).
    __setStoreBackendForTests(null);
    const s = createAtomicStore("marks.json");
    await expect(s.get("marks")).rejects.toThrow();
    useMemoryStoreBackend();
  });

  it("is a fresh read after a backend is installed, as after a restart", async () => {
    const s = createAtomicStore("marks.json");
    await s.set("marks", { version: 2, docs: [] });
    await s.save();
    // A new disk (a new backend) means a new read, not the old in-memory copy.
    const next = createMemoryStoreBackend();
    next.seed("marks.json", '{"marks": {"version": 2, "docs": [{"path": "/x.pdf"}]}}');
    __setStoreBackendForTests(next);
    const reopened = createAtomicStore("marks.json");
    expect(await reopened.get("marks")).toEqual({ version: 2, docs: [{ path: "/x.pdf" }] });
    useMemoryStoreBackend();
  });
});
