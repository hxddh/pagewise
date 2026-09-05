/**
 * Reading a versioned store without ever throwing its contents away.
 *
 * Every per-document store here — marks, findings — is a JSON blob with a
 * `version` field, and until 12.0 each one answered a version it did not
 * recognise the same way: return `[]`. That is the right answer for a cache
 * and the wrong one for the reader's own work. Bumping `VERSION` in
 * `finding-store.ts` would have emptied every reader's record on first launch,
 * silently, and the two stores' own comments knew it — which is why 9.0 opened
 * a second file rather than touch the first.
 *
 * So a version number that cannot be bumped is not a version number. This is
 * the missing half: a chain of migrations from each older shape to the current
 * one, and a rule for the two shapes the chain cannot handle.
 *
 *   - OLDER than current: run each migration in turn. The result is read as
 *     current and written back as current on the next flush.
 *   - NEWER than current: the file was written by a later PageWise and this
 *     one has been downgraded. The blob is stashed under `<key>.newer` before
 *     the store is read as empty, so the later version finds it again — see
 *     `preserveKey`. It is never overwritten if one is already there.
 *   - NOT A VERSIONED BLOB: corrupt, or from before versions existed. Read as
 *     empty, exactly as before; there is nothing to migrate.
 */

export interface Migration {
  /** The version this migration reads. */
  from: number;
  /** Turn a `from`-shaped blob into a `from + 1`-shaped one. */
  migrate: (raw: Record<string, unknown>) => Record<string, unknown>;
}

export type MigrationOutcome =
  | { status: "current"; value: Record<string, unknown> }
  | { status: "migrated"; value: Record<string, unknown>; from: number }
  | { status: "newer"; version: number; raw: unknown }
  | { status: "invalid" };

function versionOf(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const v = (raw as { version?: unknown }).version;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

/**
 * Bring a stored blob up to `current`, or say why it cannot be.
 *
 * Pure: the caller decides what to do with a `newer` blob, because only the
 * caller has the store to stash it in.
 */
export function migrateStored(
  raw: unknown,
  current: number,
  migrations: readonly Migration[],
): MigrationOutcome {
  const version = versionOf(raw);
  if (version === null) return { status: "invalid" };
  if (version === current) return { status: "current", value: raw as Record<string, unknown> };
  if (version > current) return { status: "newer", version, raw };

  let value = raw as Record<string, unknown>;
  for (let v = version; v < current; v += 1) {
    const step = migrations.find((m) => m.from === v);
    // A gap in the chain is a programming error, not a data error: fail
    // closed rather than read a shape nothing declared how to read.
    if (!step) return { status: "invalid" };
    value = { ...step.migrate(value), version: v + 1 };
  }
  return { status: "migrated", value, from: version };
}

/** Where a blob from a later version is kept until that version returns. */
export function preserveKey(key: string): string {
  return `${key}.newer`;
}

/**
 * Stash a newer-version blob beside the key it came from.
 *
 * Only when nothing is already stashed there: two downgrades in a row must not
 * let the second — which would find the store empty and write an empty blob —
 * replace the first, which is the one with the reader's work in it.
 */
export async function preserveNewer(
  store: {
    get<T>(key: string): Promise<T | null | undefined>;
    set(key: string, value: unknown): Promise<void>;
    save(): Promise<void>;
  },
  key: string,
  raw: unknown,
): Promise<void> {
  const slot = preserveKey(key);
  const existing = await store.get<unknown>(slot);
  if (existing !== null && existing !== undefined) return;
  await store.set(slot, raw);
  await store.save();
}
