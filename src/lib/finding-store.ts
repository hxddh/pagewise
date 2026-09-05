/**
 * What the agent worked out about the document.
 *
 * PageWise's six document tools are all retrieval — outline, search, and four
 * readers. Nothing wrote anything down, so every question started from zero:
 * the agent read page 12, answered, and six questions later read page 12 again
 * from scratch. `compact-run-messages.ts` made that forgetting cheap without
 * making it rare. A finding is the other half: a claim, the pages it came from,
 * and the evidence that supports it, kept after the run ends.
 *
 * Anchored on page numbers, not geometry — the opposite choice from a mark, and
 * for the same underlying reason. A mark is made by dragging over a rectangle,
 * so a rectangle is what the reader actually pointed at. A finding is made by
 * reading page text, and the agent has no coordinates: it never sees the page
 * as a picture. Pinning a claim to a rectangle it did not choose would be an
 * invented anchor, which is worse than a coarse honest one.
 *
 * This is also why findings are not `Mark`s. `addMark` rejects an empty
 * `rects`, correctly — a mark with no rectangle cannot be drawn — and a finding
 * has none to give.
 *
 * SEPARATE STORE FILE, deliberately. At 9.0, adding findings to `marks.json`
 * meant bumping its version, and `sanitizeStoredMarks` returned [] when the
 * version did not match: every existing reader's marks would have been
 * silently discarded on first launch. 12.0 gave both stores a migration chain
 * (`store-migrate.ts`) so a version can change without that; the two files
 * stay separate because they are different things, not because merging them
 * would still be destructive.
 *
 * APPEND AND REVISE, never edit. A finding is never rewritten in place. When
 * later reading contradicts an earlier claim, a new finding is written carrying
 * `supersedes` and `why`, and the old text stays exactly as it was. An agent
 * that can only append accumulates contradictions; one that can silently
 * overwrite leaves no trace of having been wrong. Both are worse than a record
 * that says what it changed its mind about.
 */
import { LazyStore } from "@tauri-apps/plugin-store";
import { migrateStored, preserveNewer, type Migration } from "./store-migrate";

const STORE_PATH = "findings.json";
const KEY = "findings";
/**
 * 2 since 12.0. The bump itself changes nothing in the shape — every new field
 * is optional — and that is the point of bumping it now: the first version
 * change is the one that proves `migrateStored` keeps a 1-era record intact,
 * before a change that actually needs it.
 */
const VERSION = 2;

const MIGRATIONS: readonly Migration[] = [
  // 1 → 2: `body`, `source`, `confirmedAt` on a finding and `identity` on a
  // document are all optional additions. A v1 blob is a valid v2 blob.
  { from: 1, migrate: (raw) => raw },
];

/** Findings kept for one document. A defence against runaway state, not a policy. */
export const MAX_FINDINGS_PER_DOC = 500;
/** Findings kept in total, across every document. */
export const MAX_FINDINGS_TOTAL = 5_000;
/** Longest claim stored. One sentence is the intent; this is the backstop. */
export const MAX_CLAIM_TEXT = 500;
/** Longest evidence quote stored, matching the mark snapshot cap. */
export const MAX_EVIDENCE_TEXT = 1_000;
/**
 * Longest full answer a reader may keep. The claim is one sentence and the
 * body is the whole answer it was cut from; a body longer than this is a
 * transcript, and the transcript already exists.
 */
export const MAX_BODY_TEXT = 20_000;
/** Most pages one finding may cite. A claim spanning more is not one claim. */
export const MAX_FINDING_PAGES = 20;
/** Coalesce a burst of writes into one flush, as the mark store does. */
const FLUSH_DELAY_MS = 400;

export interface Finding {
  id: string;
  /** 1-based, ascending, deduplicated. Never empty — see `addFinding`. */
  pages: number[];
  /** What was established. */
  claim: string;
  /** What on those pages supports it. */
  evidence: string;
  /** The id this finding replaces, when it is a revision. */
  supersedes?: string;
  /** Why the earlier claim was wrong. Only meaningful beside `supersedes`. */
  why?: string;
  /** The reader struck this out. It never re-enters the agent's context. */
  struck?: boolean;
  /**
   * Who wrote it. Absent means the assistant, which is every finding written
   * before 9.2 and most of them after — so the common case stores nothing
   * extra, the same way a text mark omits `kind`.
   *
   * It is not cosmetic. A reader keeping an answer and the assistant recording
   * an inference are different acts, and a record that cannot tell them apart
   * is the failure mode this whole thing has to avoid.
   */
  author?: "reader";
  createdAt: number;
  /** The file's stamp when it was written — see `findingsAreStale`. */
  stamp: string;
  /**
   * The whole answer this was kept from, as Markdown. Only a reader's kept
   * answer has one; the claim is its one-line summary. Until 12.0 the first
   * 500 characters of the answer WERE the record of it, and a table, a list,
   * or the qualifying sentence at the end were simply gone.
   */
  body?: string;
  /** The answer it came from, so the record can lead back to it. */
  source?: { messageId: string };
  /**
   * When the reader said "I checked this". Set by editing the claim or by
   * confirming it outright; it is the one trust state only a person can
   * grant — see `finding-trust.ts`.
   */
  confirmedAt?: number;
}

interface StoredDoc {
  path: string;
  /**
   * Content fingerprint of the file these were written on — see
   * `file-identity.ts`. Lets a renamed or moved file find its record again.
   * Absent for documents last opened before 12.0.
   */
  identity?: string;
  findings: Finding[];
}

interface StoredFindings {
  version: number;
  docs: StoredDoc[];
}

let store: LazyStore | null = null;

async function getStore(): Promise<LazyStore> {
  if (!store) store = new LazyStore(STORE_PATH);
  return store;
}

/**
 * Serializes every mutation through one promise chain — the same reason the
 * mark store does: an unserialized read-modify-write loses entries to
 * last-write-wins, and a lost finding is work that has to be paid for again.
 */
let storeLock: Promise<unknown> = Promise.resolve();
function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = storeLock.then(fn, fn);
  storeLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Ascending, deduplicated, whole, ≥ 1, and capped. */
export function normalizePages(raw: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const n of raw) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) continue;
    seen.add(n);
  }
  return [...seen].sort((a, b) => a - b).slice(0, MAX_FINDING_PAGES);
}

function isValidFinding(value: unknown): value is Finding {
  if (!value || typeof value !== "object") return false;
  const f = value as Partial<Finding>;
  return (
    typeof f.id === "string" &&
    f.id.length > 0 &&
    Array.isArray(f.pages) &&
    f.pages.length > 0 &&
    f.pages.every((p) => typeof p === "number" && Number.isInteger(p) && p >= 1) &&
    typeof f.claim === "string" &&
    f.claim.length > 0 &&
    typeof f.evidence === "string" &&
    typeof f.createdAt === "number" &&
    Number.isFinite(f.createdAt) &&
    typeof f.stamp === "string" &&
    (f.supersedes === undefined || typeof f.supersedes === "string") &&
    (f.why === undefined || typeof f.why === "string") &&
    (f.struck === undefined || typeof f.struck === "boolean") &&
    (f.author === undefined || f.author === "reader") &&
    (f.body === undefined || typeof f.body === "string") &&
    (f.source === undefined ||
      (typeof f.source === "object" &&
        f.source !== null &&
        typeof (f.source as { messageId?: unknown }).messageId === "string")) &&
    (f.confirmedAt === undefined ||
      (typeof f.confirmedAt === "number" && Number.isFinite(f.confirmedAt)))
  );
}

/**
 * Coerce arbitrary stored data into findings.
 *
 * Corrupt state must never block a document from opening. A finding with no
 * pages is dropped rather than kept: an unanchored claim is the one thing this
 * record must never show, because the reader cannot check it against anything.
 */
export function sanitizeStoredFindings(raw: unknown): StoredDoc[] {
  const outcome = migrateStored(raw, VERSION, MIGRATIONS);
  if (outcome.status !== "current" && outcome.status !== "migrated") return [];
  const parsed = outcome.value as Partial<StoredFindings>;
  if (!Array.isArray(parsed.docs)) return [];
  const out: StoredDoc[] = [];
  let total = 0;
  for (const doc of parsed.docs) {
    if (!doc || typeof doc !== "object") continue;
    const d = doc as Partial<StoredDoc>;
    if (typeof d.path !== "string" || !d.path || !Array.isArray(d.findings)) continue;
    const findings = d.findings.filter(isValidFinding).slice(0, MAX_FINDINGS_PER_DOC);
    if (findings.length === 0) continue;
    if (total + findings.length > MAX_FINDINGS_TOTAL) continue;
    total += findings.length;
    out.push({
      path: d.path,
      findings,
      ...(typeof d.identity === "string" && d.identity ? { identity: d.identity } : {}),
    });
  }
  return out;
}

async function readDocs(): Promise<StoredDoc[]> {
  const s = await getStore();
  const raw = await s.get<unknown>(KEY);
  const outcome = migrateStored(raw, VERSION, MIGRATIONS);
  if (outcome.status === "newer") {
    // Written by a later PageWise. Kept aside, never overwritten: reading the
    // store as empty and then flushing would otherwise replace it.
    await preserveNewer(s, KEY, raw).catch(() => {});
    return [];
  }
  return sanitizeStoredFindings(raw);
}

async function writeDocs(docs: StoredDoc[]): Promise<void> {
  const s = await getStore();
  await s.set(KEY, { version: VERSION, docs } satisfies StoredFindings);
  await s.save();
}

/** In-memory findings for the open document, so the sidebar never awaits disk. */
const findingsByPath = new Map<string, Finding[]>();
/** The fingerprint the open document was loaded with, written back on flush. */
const identityByPath = new Map<string, string>();
type FindingListener = (path: string) => void;
const listeners = new Set<FindingListener>();

function notify(path: string): void {
  for (const listener of listeners) {
    try {
      listener(path);
    } catch {
      // A misbehaving subscriber must not break finding updates.
    }
  }
}

export function subscribeFindings(listener: FindingListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every finding for `path`, oldest first — including struck and superseded. */
export function getFindings(path: string): Finding[] {
  return findingsByPath.get(path) ?? [];
}

/** True when some later finding replaced this one. */
export function isSuperseded(findings: readonly Finding[], id: string): boolean {
  return findings.some((f) => f.supersedes === id);
}

/**
 * How many leading characters of an id identify a finding to the agent.
 *
 * `revise_finding` takes an id, and nothing ever gave the agent one. Within a
 * single run `note_finding` returns it, so the agent can correct what it just
 * wrote; across runs — which is the only reason this store is on disk — the
 * record note listed claims and pages and no identifier at all, while ending
 * with "use revise_finding to correct it". The instruction was unfollowable.
 *
 * A full `crypto.randomUUID()` is 36 characters. Spending 38 of a 2,000-char
 * record budget per line on an identifier would take roughly a fifth of the
 * record away from the claims it exists to carry — and that budget is paid on
 * every question. Six hex characters is 16.7M values against a 500-finding
 * per-document cap, and `resolveFindingId` refuses an ambiguous one rather than
 * guessing, so the short form costs a handful of characters and can never
 * silently revise the wrong claim.
 */
export const FINDING_HANDLE_LEN = 6;

/** The short form of an id, as the agent is shown it. */
export function findingHandle(id: string): string {
  return id.replace(/-/g, "").slice(0, FINDING_HANDLE_LEN);
}

/**
 * Turn what the agent said back into a finding id.
 *
 * Exact ids still work — the agent has one for anything `note_finding` returned
 * in this run — so the short handle is an addition, not a replacement. A prefix
 * matching more than one finding resolves to null: revising the wrong claim is
 * worse than refusing, because the record is what the next run is told.
 */
export function resolveFindingId(path: string, handle: string): string | null {
  const wanted = handle.trim();
  if (!wanted) return null;
  const all = getFindings(path);
  if (all.some((f) => f.id === wanted)) return wanted;
  const folded = wanted.replace(/-/g, "").toLowerCase();
  if (!folded) return null;
  const matches = all.filter((f) => f.id.replace(/-/g, "").toLowerCase().startsWith(folded));
  return matches.length === 1 ? matches[0]!.id : null;
}

/**
 * What the agent is entitled to be told on the next turn.
 *
 * Struck findings are excluded because the reader said they were wrong, and a
 * memory the reader cannot correct is a liability rather than a feature.
 * Superseded ones are excluded because the revision replaced them — both are
 * still shown in the sidebar, where the history is the point.
 */
export function activeFindings(path: string): Finding[] {
  const all = getFindings(path);
  return all.filter((f) => !f.struck && !isSuperseded(all, f.id));
}

export function findingsOnPage(path: string, page: number): Finding[] {
  return getFindings(path).filter((f) => f.pages.includes(page));
}

/** Pages carrying at least one finding, ascending. */
export function pagesWithFindings(path: string): number[] {
  const pages = new Set<number>();
  for (const f of getFindings(path)) for (const p of f.pages) pages.add(p);
  return [...pages].sort((a, b) => a - b);
}

/**
 * Findings written against a different version of the file than the one open.
 *
 * Kept and flagged rather than discarded, exactly as marks are: the page a
 * claim cites may have moved, but the claim and its evidence still say what was
 * read, and only the reader can judge whether that still holds.
 */
export function findingsAreStale(path: string, stamp: string): boolean {
  if (!stamp) return false;
  return getFindings(path).some((f) => f.stamp !== stamp);
}

/** Oldest first: a record is read as a history, not as a page index. */
function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Load a document's findings into memory. Call once per open.
 *
 * Looked up by path first, then by content fingerprint. A record found under
 * another path with this file's fingerprint belongs to this file — it was
 * renamed or moved — and is re-keyed to the path it now has. Until 12.0 a
 * rename left the record stranded under the old path, which the reader saw as
 * "my notes are gone" though nothing on disk had been touched.
 */
export async function loadFindings(path: string, identity?: string): Promise<Finding[]> {
  if (identity) identityByPath.set(path, identity);
  else identityByPath.delete(path);
  try {
    const docs = await withStoreLock(readDocs);
    let doc = docs.find((d) => d.path === path);
    if (!doc && identity) {
      const moved = docs.find((d) => d.identity === identity);
      if (moved) {
        doc = moved;
        // Re-keyed in memory now and on disk at the next flush: `dirty` names
        // both paths, so the old key is dropped and the new one written.
        findingsByPath.set(moved.path, []);
        dirty.add(moved.path);
        dirty.add(path);
        scheduleFlush();
      }
    }
    const findings = sortFindings(doc?.findings ?? []);
    findingsByPath.set(path, findings);
    notify(path);
    return findings;
  } catch {
    findingsByPath.set(path, []);
    return [];
  }
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
const dirty = new Set<string>();
let flushInFlight: Promise<void> = Promise.resolve();

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushFindingStore();
  }, FLUSH_DELAY_MS);
}

/** Write pending changes now (document close, app quit). */
export async function flushFindingStore(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (dirty.size === 0) {
    await flushInFlight;
    return;
  }
  const paths = [...dirty];
  dirty.clear();
  flushInFlight = withStoreLock(async () => {
    const docs = await readDocs();
    const byPath = new Map(docs.map((d) => [d.path, d] as const));
    for (const path of paths) {
      const findings = findingsByPath.get(path) ?? [];
      if (findings.length === 0) byPath.delete(path);
      else {
        const identity = identityByPath.get(path) ?? byPath.get(path)?.identity;
        byPath.set(path, {
          path,
          findings: findings.slice(0, MAX_FINDINGS_PER_DOC),
          ...(identity ? { identity } : {}),
        });
      }
    }
    let total = 0;
    const kept: StoredDoc[] = [];
    for (const doc of byPath.values()) {
      if (total + doc.findings.length > MAX_FINDINGS_TOTAL) continue;
      total += doc.findings.length;
      kept.push(doc);
    }
    await writeDocs(kept);
  }).catch(() => {
    // A failed write must not lose the findings — they stay in memory and in
    // `dirty` for the next attempt.
    for (const path of paths) dirty.add(path);
  });
  await flushInFlight;
}

function mutate(path: string, next: Finding[]): void {
  findingsByPath.set(path, sortFindings(next));
  dirty.add(path);
  notify(path);
  scheduleFlush();
}

export interface NewFinding {
  pages: number[];
  claim: string;
  evidence?: string;
  stamp: string;
  /** Set when this replaces an earlier finding. */
  supersedes?: string;
  why?: string;
  /** Omit for the assistant's own findings. */
  author?: "reader";
  /** The whole answer, when a reader keeps one. See `Finding.body`. */
  body?: string;
  source?: { messageId: string };
}

/**
 * Write a finding, or return null when it cannot be written.
 *
 * Null for an empty claim, for no usable pages, and at the per-document cap.
 * The pages check is the important one and it is deliberately not lenient: a
 * finding with no anchor is the failure mode this whole record has to avoid,
 * because the reader cannot get from the claim back to the text, and the agent
 * will still be told it next turn.
 */
export function addFinding(path: string, input: NewFinding): Finding | null {
  const existing = getFindings(path);
  if (existing.length >= MAX_FINDINGS_PER_DOC) return null;
  const claim = input.claim.trim().slice(0, MAX_CLAIM_TEXT);
  if (!claim) return null;
  const pages = normalizePages(input.pages);
  if (pages.length === 0) return null;

  const finding: Finding = {
    id: crypto.randomUUID(),
    pages,
    claim,
    evidence: (input.evidence ?? "").trim().slice(0, MAX_EVIDENCE_TEXT),
    createdAt: Date.now(),
    stamp: input.stamp,
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    ...(input.author ? { author: input.author } : {}),
    ...(input.why ? { why: input.why.trim().slice(0, MAX_CLAIM_TEXT) } : {}),
    ...(input.body?.trim() ? { body: input.body.trim().slice(0, MAX_BODY_TEXT) } : {}),
    ...(input.source?.messageId ? { source: { messageId: input.source.messageId } } : {}),
  };
  mutate(path, [...existing, finding]);
  return finding;
}

/**
 * Replace an earlier finding with a corrected one.
 *
 * The old record is untouched. What makes this a revision rather than a second
 * opinion is `supersedes`, which takes the old claim out of `activeFindings`
 * while leaving it on screen with the reason it was overturned.
 */
export function reviseFinding(
  path: string,
  id: string,
  input: Omit<NewFinding, "supersedes">,
): Finding | null {
  const existing = getFindings(path);
  if (!existing.some((f) => f.id === id)) return null;
  // Revising something already revised would fork the history into two live
  // claims, and this record is a single timeline by design.
  if (isSuperseded(existing, id)) return null;
  return addFinding(path, { ...input, supersedes: id });
}

/**
 * The reader's correction. Struck findings stay visible and stop being told to
 * the agent — see `activeFindings`.
 */
export function setFindingStruck(path: string, id: string, struck: boolean): void {
  const existing = getFindings(path);
  let changed = false;
  const next = existing.map((f) => {
    if (f.id !== id || Boolean(f.struck) === struck) return f;
    changed = true;
    return struck ? { ...f, struck: true } : { ...f, struck: undefined };
  });
  if (changed) mutate(path, next);
}

/**
 * The reader says a claim is right — or rewrites it so that it is.
 *
 * Either way the entry becomes theirs to vouch for, which is the one trust
 * state no lookup can grant: the page can confirm that the wording exists,
 * and only a person can confirm that the claim follows from it. A rewritten
 * claim keeps its body, evidence and pages; only the sentence changes.
 *
 * `stamp` is the open file's. Checking an entry against the file that is
 * open is exactly what "re-check" asks for when the file has changed, so a
 * confirmation carries the entry forward to that version. Without it the
 * entry would stay flagged as stale with the reader's confirmation on it,
 * and the control that put it there would have visibly done nothing.
 */
export function confirmFinding(
  path: string,
  id: string,
  confirmed = true,
  stamp?: string,
): void {
  const existing = getFindings(path);
  let changed = false;
  const next = existing.map((f) => {
    if (f.id !== id) return f;
    if (!confirmed) {
      if (!f.confirmedAt) return f;
      changed = true;
      const { confirmedAt: _dropped, ...rest } = f;
      return rest;
    }
    const restamped = stamp && f.stamp !== stamp;
    if (f.confirmedAt && !restamped) return f;
    changed = true;
    return { ...f, confirmedAt: Date.now(), ...(restamped ? { stamp } : {}) };
  });
  if (changed) mutate(path, next);
}

export function setFindingClaim(
  path: string,
  id: string,
  claim: string,
  stamp?: string,
): boolean {
  const trimmed = claim.trim().slice(0, MAX_CLAIM_TEXT);
  if (!trimmed) return false;
  const existing = getFindings(path);
  let changed = false;
  const next = existing.map((f) => {
    if (f.id !== id) return f;
    const restamped = stamp && f.stamp !== stamp;
    if (f.claim === trimmed && f.confirmedAt && !restamped) return f;
    changed = true;
    return {
      ...f,
      claim: trimmed,
      confirmedAt: Date.now(),
      ...(restamped ? { stamp } : {}),
    };
  });
  if (changed) mutate(path, next);
  return changed;
}

export function removeFinding(path: string, id: string): void {
  const existing = getFindings(path);
  const next = existing.filter((f) => f.id !== id);
  if (next.length !== existing.length) mutate(path, next);
}

/** Drop a document's findings from memory. The stored copy is untouched. */
export function forgetFindings(path: string): void {
  findingsByPath.delete(path);
  identityByPath.delete(path);
}

/** Reset module state between tests. */
export function __resetFindingStoreForTests(): void {
  findingsByPath.clear();
  identityByPath.clear();
  listeners.clear();
  dirty.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  store = null;
}
