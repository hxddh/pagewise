import { describe, expect, it } from "vitest";
import { migrateStored, preserveKey, preserveNewer, type Migration } from "./store-migrate";

/**
 * The rule that lets a store's version number actually change.
 *
 * Before this, `sanitizeStoredMarks` and `sanitizeStoredFindings` both
 * returned [] on any version they did not recognise, which made bumping the
 * number the one change guaranteed to destroy the reader's work. These hold the
 * three outcomes that replace that: older is migrated, newer is kept aside, and
 * only a blob with no version at all is read as empty.
 */
describe("migrateStored", () => {
  const migrations: Migration[] = [
    { from: 1, migrate: (raw) => ({ ...raw, docs: (raw.docs as unknown[]).map((d) => ({ ...(d as object), identity: "" })) }) },
    { from: 2, migrate: (raw) => ({ ...raw, note: "v3" }) },
  ];

  it("reads the current version as it is", () => {
    const out = migrateStored({ version: 3, docs: [] }, 3, migrations);
    expect(out.status).toBe("current");
  });

  it("walks an older blob up through every step", () => {
    const out = migrateStored({ version: 1, docs: [{ path: "/a" }] }, 3, migrations);
    expect(out.status).toBe("migrated");
    if (out.status !== "migrated") return;
    expect(out.from).toBe(1);
    expect(out.value.version).toBe(3);
    expect(out.value.note).toBe("v3");
    expect(out.value.docs).toEqual([{ path: "/a", identity: "" }]);
  });

  it("refuses a blob from a later version rather than misreading it", () => {
    const out = migrateStored({ version: 9, docs: [] }, 3, migrations);
    expect(out.status).toBe("newer");
  });

  it("reads a blob with no version as invalid", () => {
    expect(migrateStored(null, 3, migrations).status).toBe("invalid");
    expect(migrateStored({ docs: [] }, 3, migrations).status).toBe("invalid");
    expect(migrateStored({ version: "1" }, 3, migrations).status).toBe("invalid");
  });

  it("fails closed on a gap in the chain", () => {
    // Version 1 with only the 2→3 step declared: nothing says how to read it.
    const out = migrateStored({ version: 1 }, 3, [migrations[1]!]);
    expect(out.status).toBe("invalid");
  });
});

describe("preserveNewer", () => {
  function fakeStore() {
    const data = new Map<string, unknown>();
    let saves = 0;
    return {
      data,
      saves: () => saves,
      async get<T>(key: string) {
        return (data.get(key) ?? null) as T | null;
      },
      async set(key: string, value: unknown) {
        data.set(key, value);
      },
      async save() {
        saves += 1;
      },
    };
  }

  it("stashes a newer blob beside its key", async () => {
    const store = fakeStore();
    await preserveNewer(store, "findings", { version: 9, docs: [1] });
    expect(store.data.get(preserveKey("findings"))).toEqual({ version: 9, docs: [1] });
    expect(store.saves()).toBe(1);
  });

  it("never overwrites a stash that is already there", async () => {
    // Two downgrades in a row: the second would find the store empty and
    // offer an empty blob. The first stash is the one with the work in it.
    const store = fakeStore();
    await preserveNewer(store, "findings", { version: 9, docs: [1] });
    await preserveNewer(store, "findings", { version: 9, docs: [] });
    expect(store.data.get(preserveKey("findings"))).toEqual({ version: 9, docs: [1] });
    expect(store.saves()).toBe(1);
  });
});
