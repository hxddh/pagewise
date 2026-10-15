/**
 * Persistent page-index cache.
 *
 * Vision indexing is the only part of PageWise that spends the user's money per
 * page, and before this store every page was re-indexed — and re-billed — on the
 * next app launch (the in-memory `docCache` holds one document and dies with the
 * process). Pages that cost a vision call are written here, keyed by path plus a
 * freshness stamp, so reopening a document reuses what was already paid for.
 *
 * Only vision-derived text is persisted: natively extracted text is free to
 * recompute on open, so caching it would spend the size budget on nothing.
 */
import { createAtomicStore } from "./atomic-store";
import { MIN_INDEX_CHARS } from "./page-text-merge";
import { createStoreRuntime } from "./json-store";
import { migrateStored, preserveNewer, type Migration } from "./store-migrate";
import type { PageText } from "./types";

const STORE_PATH = "index-cache.json";
const KEY = "index";
/**
 * The schema version of the stored blob, stated here and written with every
 * save. It was 1 since 13.0; 20.0 gave the store the migration chain every
 * other versioned store has (`store-migrate.ts`), so this number can move
 * without the reader's paid-for text being dropped.
 */
const VERSION = 1;

/**
 * How a blob of an older version reaches this one. Empty while VERSION is 1 —
 * there is nothing older — and the place the first bump adds its step, rather
 * than the "return []" this store used to answer a version it did not
 * recognise with.
 */
const MIGRATIONS: readonly Migration[] = [];

/** Retained documents. Beyond this the least-recently-saved are dropped. */
export const MAX_CACHED_INDEX_DOCS = 24;
/** Ceiling on total retained page text, in UTF-16 code units (~2 bytes each). */
export const MAX_INDEX_CHARS = 6_000_000;
/** No single document may consume more than this much of the budget. */
const MAX_DOC_CHARS = 2_000_000;
/** Coalesce the write burst from a concurrent sweep into one save. */
const FLUSH_DELAY_MS = 800;

interface StoredDoc {
  path: string;
  /**
   * The file's content fingerprint (`file-identity.ts`), since 13.0. Lets a
   * renamed or moved scan find the pages already paid for; before it, only
   * the marks, the record and the chat followed a rename, and every page of
   * the scan was re-billed. Optional and additive, so the store version stays.
   */
  identity?: string;
  stamp: string;
  totalPages: number;
  pages: PageText[];
  savedAt: number;
}

interface StoredIndex {
  version: number;
  docs: StoredDoc[];
}

export interface IndexCacheStats {
  docs: number;
  pages: number;
  chars: number;
}

/**
 * Serializes every mutation through one promise chain. Vision pages land from
 * three concurrent workers, so an unserialized read-modify-write would drop
 * paid-for pages via last-write-wins.
 */
const runtime = createStoreRuntime(() => createAtomicStore(STORE_PATH));

function isValidPage(value: unknown): value is PageText {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<PageText>;
  return (
    typeof p.page === "number" &&
    Number.isInteger(p.page) &&
    p.page >= 1 &&
    typeof p.text === "string"
  );
}

function isValidDoc(value: unknown): value is StoredDoc {
  if (!value || typeof value !== "object") return false;
  const d = value as Partial<StoredDoc>;
  return (
    typeof d.path === "string" &&
    d.path.length > 0 &&
    typeof d.stamp === "string" &&
    typeof d.totalPages === "number" &&
    Number.isFinite(d.totalPages) &&
    typeof d.savedAt === "number" &&
    Number.isFinite(d.savedAt) &&
    Array.isArray(d.pages)
  );
}

/**
 * Coerce arbitrary stored data into valid documents. A corrupt cache must never
 * block a document from opening — bad entries are dropped, not thrown on.
 *
 * Version handling goes through `migrateStored`, like marks and findings: an
 * OLDER blob is migrated, a NEWER one is preserved beside the key (see
 * `readDocs`) rather than discarded — this store holds text the reader paid for
 * per page, and answering a version mismatch with `[]` re-billed every page of
 * it after one downgrade.
 */
export function sanitizeStoredIndex(raw: unknown): StoredDoc[] {
  const outcome = migrateStored(raw, VERSION, MIGRATIONS);
  if (outcome.status !== "current" && outcome.status !== "migrated") return [];
  const parsed = outcome.value as Partial<StoredIndex>;
  if (!Array.isArray(parsed.docs)) return [];
  const seen = new Set<string>();
  const docs: StoredDoc[] = [];
  for (const entry of parsed.docs) {
    if (!isValidDoc(entry)) continue;
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const pages = entry.pages.filter(isValidPage).filter((p) => p.text.length > 0);
    if (pages.length === 0) continue;
    docs.push({ ...entry, pages });
  }
  return docs;
}

export function docChars(doc: StoredDoc): number {
  let total = 0;
  for (const page of doc.pages) total += page.text.length;
  return total;
}

/**
 * Enforce the size budget: newest-saved documents win, oldest are dropped.
 * `keepPath` is never evicted — it is the document that just paid for a page.
 */
export function evictToBudget(docs: StoredDoc[], keepPath?: string): StoredDoc[] {
  const ordered = [...docs].sort((a, b) => b.savedAt - a.savedAt);
  const kept: StoredDoc[] = [];
  let chars = 0;
  for (const doc of ordered) {
    const size = docChars(doc);
    const protectedDoc = doc.path === keepPath;
    if (!protectedDoc && kept.length >= MAX_CACHED_INDEX_DOCS) continue;
    if (!protectedDoc && chars + size > MAX_INDEX_CHARS) continue;
    kept.push(doc);
    chars += size;
  }
  return kept;
}

/** Trim a single document's pages so one huge scan can't fill the whole budget. */
function capDocPages(pages: PageText[]): PageText[] {
  let chars = 0;
  const kept: PageText[] = [];
  for (const page of [...pages].sort((a, b) => a.page - b.page)) {
    if (chars + page.text.length > MAX_DOC_CHARS) continue;
    kept.push(page);
    chars += page.text.length;
  }
  return kept;
}

async function readDocs(): Promise<StoredDoc[]> {
  const s = await runtime.store();
  const raw = await s.get<unknown>(KEY);
  const outcome = migrateStored(raw, VERSION, MIGRATIONS);
  if (outcome.status === "newer") {
    // Written by a later PageWise and this one has been downgraded. Keep the
    // blob beside the key, never overwritten, so going back to the later
    // version finds the pages it paid for; reading it as empty here would
    // otherwise replace them on the next save.
    await preserveNewer(s, KEY, raw).catch(() => {});
    return [];
  }
  return sanitizeStoredIndex(raw);
}

async function writeDocs(docs: StoredDoc[]): Promise<void> {
  const s = await runtime.store();
  const payload: StoredIndex = { version: VERSION, docs };
  await s.set(KEY, payload);
  await s.save();
}

/** Fingerprints of the documents opened this session, written beside their pages. */
const identityByPath = new Map<string, string>();

/**
 * Drop the fingerprint remembered for a closed document (20.0).
 *
 * A flush uses the open document's fingerprint to write it beside its pages;
 * once the document is closed it is of no use to anyone, and until 20.0 the
 * map only ever grew — one entry per document opened this session. Registered
 * with the document scope like every other per-document cache.
 */
export function forgetIndexIdentity(path: string): void {
  identityByPath.delete(path);
}

/** Test seam — how many fingerprints the module is holding. */
export function __indexIdentitySizeForTests(): number {
  return identityByPath.size;
}

/**
 * Pages persisted for `path`, or `[]` when the file changed or nothing is cached.
 *
 * With `identity`, a document cached under another path whose content has the
 * same fingerprint is the same file moved or renamed: its pages are returned
 * and the entry is re-keyed to where the file is now.
 */
export async function loadIndexedPages(path: string, stamp: string, identity?: string): Promise<PageText[]> {
  if (identity) identityByPath.set(path, identity);
  try {
    const docs = await runtime.withStoreLock(readDocs);
    let doc = docs.find((d) => d.path === path && d.stamp === stamp);
    if (!doc && identity && !docs.some((d) => d.path === path && d.stamp === stamp)) {
      const moved = docs.find((d) => d.identity === identity && d.path !== path);
      if (moved) {
        doc = moved;
        await runtime.withStoreLock(async () => {
          const current = await readDocs();
          const next = current
            .filter((d) => d.path !== path)
            .map((d) => (d.path === moved.path && d.identity === identity ? { ...d, path, stamp } : d));
          await writeDocs(next);
        }).catch(() => undefined);
      }
    }
    if (!doc) return [];
    // Only vision-derived text is ever written here (see the module docs), so
    // the provenance is known and must travel with the text — the merge rules
    // use it to keep free re-extraction from displacing what was paid for.
    return doc.pages
      .filter((p) => p.text.trim().length >= MIN_INDEX_CHARS)
      .map((p) => ({ ...p, source: "vision" as const }));
  } catch {
    // A cache miss is always safe — the pages are re-derived (re-indexed).
    return [];
  }
}

type PendingDoc = {
  stamp: string;
  totalPages: number;
  pages: Map<number, string>;
};

const pending = new Map<string, PendingDoc>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight: Promise<void> = Promise.resolve();

async function flushPending(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pending.size === 0) return;
  const batch = [...pending.entries()];
  pending.clear();

  await runtime.withStoreLock(async () => {
    try {
      const docs = await readDocs();
      const byPath = new Map(docs.map((d) => [d.path, d]));
      const now = Date.now();

      for (const [path, entry] of batch) {
        const existing = byPath.get(path);
        // A stamp change means the file was rewritten: the old pages describe
        // different content and must not be merged into the new ones.
        const basePages =
          existing && existing.stamp === entry.stamp ? existing.pages : [];
        const merged = new Map(basePages.map((p) => [p.page, p.text]));
        for (const [page, text] of entry.pages) merged.set(page, text);

        const pages = capDocPages(
          [...merged.entries()].map(([page, text]) => ({ page, text })),
        );
        if (pages.length === 0) {
          byPath.delete(path);
          continue;
        }
        const identity = identityByPath.get(path) ?? existing?.identity;
        byPath.set(path, {
          path,
          ...(identity ? { identity } : {}),
          stamp: entry.stamp,
          totalPages: entry.totalPages,
          pages,
          savedAt: now,
        });
      }

      const keepPath = batch.length === 1 ? batch[0]![0] : undefined;
      await writeDocs(evictToBudget([...byPath.values()], keepPath));
    } catch {
      // Persisting is best-effort — a failed write must never surface as an
      // indexing error. But these pages were paid for, so put them back in the
      // buffer to ride along with the next flush instead of dropping them.
      for (const [path, entry] of batch) {
        const current = pending.get(path);
        if (!current) {
          pending.set(path, entry);
          continue;
        }
        // A newer stamp means the file changed; the old text is stale, not lost.
        if (current.stamp !== entry.stamp) continue;
        for (const [page, text] of entry.pages) {
          if (!current.pages.has(page)) current.pages.set(page, text);
        }
      }
    }
  });
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushInFlight = flushPending();
  }, FLUSH_DELAY_MS);
}

/**
 * Record a page whose text came from a (billed) vision call. Buffered briefly so
 * a concurrent sweep produces one write instead of one per page.
 */
export function rememberIndexedPage(
  path: string,
  stamp: string,
  totalPages: number,
  page: number,
  text: string,
): void {
  if (!stamp || text.trim().length < MIN_INDEX_CHARS) return;
  const existing = pending.get(path);
  // A stamp change mid-sweep invalidates whatever is still buffered for the
  // old content.
  if (existing && existing.stamp !== stamp) {
    pending.set(path, { stamp, totalPages, pages: new Map([[page, text]]) });
  } else if (existing) {
    existing.totalPages = totalPages;
    existing.pages.set(page, text);
  } else {
    pending.set(path, { stamp, totalPages, pages: new Map([[page, text]]) });
  }
  scheduleFlush();
}

/** Write any buffered pages now (document close, app quit, before stats). */
export async function flushIndexStore(): Promise<void> {
  await flushPending();
  await flushInFlight;
}

// Closing the window with pages still buffered would throw away vision calls the
// user already paid for. The unload handler can't await the write, which is why
// the debounce window is short and documents also flush when they're evicted.
if (typeof window !== "undefined") {
  const flushOnExit = () => {
    void flushPending();
  };
  window.addEventListener("beforeunload", flushOnExit);
  window.addEventListener("pagehide", flushOnExit);
}

export async function getIndexCacheStats(): Promise<IndexCacheStats> {
  await flushIndexStore();
  try {
    const docs = await runtime.withStoreLock(readDocs);
    let pages = 0;
    let chars = 0;
    for (const doc of docs) {
      pages += doc.pages.length;
      chars += docChars(doc);
    }
    return { docs: docs.length, pages, chars };
  } catch {
    return { docs: 0, pages: 0, chars: 0 };
  }
}

export async function clearIndexCache(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pending.clear();
  await runtime.withStoreLock(async () => {
    try {
      await writeDocs([]);
    } catch {
      // Nothing actionable — the user can retry from Settings.
    }
  });
}

/** Drop one document's cached index (used when its pages are invalidated). */
export async function forgetIndexedDoc(path: string): Promise<void> {
  pending.delete(path);
  await runtime.withStoreLock(async () => {
    try {
      const docs = await readDocs();
      const next = docs.filter((d) => d.path !== path);
      if (next.length !== docs.length) await writeDocs(next);
    } catch {
      // Best-effort.
    }
  });
}

/**
 * Drop just the named pages of one document's cached index.
 *
 * A re-index does not re-scan the whole document — it clears and rescans a
 * bounded window, so that the text it throws away is text it will pay to
 * replace. `forgetIndexedDoc` was called alongside it anyway, which deleted the
 * persisted copy of *every* page, including the ones outside the window that
 * keep their text and are never re-scanned. Those pages then had nothing on
 * disk: they looked fine for the rest of the session, and were billed again the
 * next time the document was opened.
 *
 * Pages outside `pages` are left exactly as they are. If nothing is left, the
 * document goes with them.
 */
export async function forgetIndexedPages(path: string, pages: number[]): Promise<void> {
  if (pages.length === 0) return;
  const drop = new Set(pages);
  const buffered = pending.get(path);
  if (buffered) {
    for (const page of drop) buffered.pages.delete(page);
    if (buffered.pages.size === 0) pending.delete(path);
  }
  await runtime.withStoreLock(async () => {
    try {
      const docs = await readDocs();
      const doc = docs.find((d) => d.path === path);
      if (!doc) return;
      const kept = doc.pages.filter((p) => !drop.has(p.page));
      if (kept.length === doc.pages.length) return;
      const next =
        kept.length === 0
          ? docs.filter((d) => d.path !== path)
          : docs.map((d) => (d.path === path ? { ...d, pages: kept } : d));
      await writeDocs(next);
    } catch {
      // Best-effort.
    }
  });
}

/** Test seam — resets module state between cases. */
export function __resetIndexStoreForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pending.clear();
  identityByPath.clear();
  runtime.resetStore();
  runtime.resetLock();
  flushInFlight = Promise.resolve();
}
