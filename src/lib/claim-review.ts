/**
 * The model's reading of whether a passage supports a sentence (15.0).
 *
 * The local checks answer two questions exactly: are the quoted words on the
 * page (13.0), and are the sentence's numbers in the passage around them
 * (15.0). They cannot answer the rest — the right figure attributed to the
 * wrong party, a condition dropped, a "not" lost — because those need reading.
 *
 * So the reader can ask their own model, per answer, on demand: for each
 * found citation, here is the sentence and here is the passage it was found
 * in; does the passage support it? The verdict is kept beside the local check,
 * never in place of it: a model can misread too, and "the words are on page
 * 12" must not become less certain because a model said something about them.
 *
 * Never automatic. The button says how many citations before anything is
 * sent.
 *
 * 21.0: one call reviews up to `REVIEW_BATCH` citations (it was one call
 * each, the instructions resent every time), and the verdicts are kept on
 * disk beside the file's stamp (they lived in memory, so a reopened document
 * exported an empty model column — "never reviewed" where the truth was "the
 * review was not kept" — and asking again paid again). A changed file drops
 * them: they were readings of a passage that may no longer be there.
 *
 * 22.0: a verdict is keyed by the page and a fingerprint of the passage it
 * read, not only by the sentence and the quote. The file's stamp does not
 * change when its text does — a scan read again with both OCR models, a page
 * indexed again — and a verdict on words that are no longer the page's must
 * not hang on the new ones. And a citation whose words were not found can be
 * asked about too, against its page's text: that is the next step for a red
 * chip, which until now could only say "not found".
 */
import { generateObject } from "ai";
import type { CitationCheck } from "./citation-check";
import { z } from "zod";
import { createAtomicStore } from "./atomic-store";
import { createStoreRuntime } from "./json-store";
import { resolveModel } from "./llm";
import { loadSettings } from "./settings";
import { assertApiKeyForAgent } from "./llm";
import { reportStoreProblem } from "./store-health";
import { addIndexUsage } from "./usage-tracker";

export type ReviewVerdict = "supports" | "contradicts" | "insufficient";

export interface ClaimReview {
  verdict: ReviewVerdict;
  /** One sentence, quoting the words it turned on. */
  reason: string;
}

const verdictSchema = z.enum(["supports", "contradicts", "insufficient"]);

export const claimReviewBatchSchema = z.object({
  reviews: z.array(
    z.object({
      /** The citation's number in the prompt, from 1. */
      item: z.number().int(),
      verdict: verdictSchema,
      reason: z.string(),
    }),
  ),
});

/** A paragraph is far shorter; a page's text is capped at the same length (`MAX_PAGE_TEXT`). */
const MAX_PASSAGE = 4000;
const MAX_REASON = 400;
/**
 * Citations per call. Eight passages at the 4,000-character cap is a prompt
 * of ~33,000 characters — well inside every preset model's window — and an
 * answer with more citations than that is rare; it becomes a few calls.
 */
export const REVIEW_BATCH = 8;

/** What a verdict was a reading of: the page, and the passage sent from it. */
export interface ReviewBasis {
  page: number;
  passage: string;
  /** The quoted words were not found; `passage` is the page's text. */
  wholePage?: boolean;
}

/**
 * What the model would be asked to read for this check, or null when there is
 * nothing to send: a found quote's paragraph, or, when the words were not
 * found on a page that has text, that page's text (22.0).
 */
export function reviewBasis(check: CitationCheck | null | undefined): ReviewBasis | null {
  if (!check) return null;
  if ((check.status === "located" || check.status === "mismatch") && check.page && check.passage) {
    return { page: check.page, passage: check.passage };
  }
  if ((check.status === "unlocated" || check.status === "unconfirmed") && check.pageText?.text) {
    return { page: check.pageText.page, passage: check.pageText.text, wholePage: true };
  }
  return null;
}

/** FNV-1a over the passage with its whitespace collapsed: the same words, the same print. */
export function passageFingerprint(passage: string): string {
  const text = passage.replace(/\s+/g, " ").trim().slice(0, MAX_PASSAGE);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

interface HeldReview {
  claim: string;
  quote: string;
  page: number;
  fp: string;
  review: ClaimReview;
}

/** Keyed by path, sentence, quote, page and passage print; the parts kept too, since a part may hold a newline. */
const reviews = new Map<string, HeldReview>();
const listeners = new Set<() => void>();
let revision = 0;

/** Changes whenever a review lands or is cleared — a snapshot for `useSyncExternalStore`. */
export function reviewRevision(): number {
  return revision;
}

function notifyReviews(): void {
  revision += 1;
  for (const l of listeners) l();
}

function key(path: string, claim: string, quote: string, page: number, fp: string): string {
  return `${path}\n${claim}\n${quote}\n${page}\n${fp}`;
}

/**
 * The verdict on this sentence and quote, if it was a reading of `basis` —
 * the passage the check finds now. No basis, or another passage: none.
 */
export function cachedReview(
  path: string,
  claim: string,
  quote: string,
  basis: ReviewBasis | null,
): ClaimReview | null {
  if (!basis) return null;
  return reviews.get(key(path, claim, quote, basis.page, passageFingerprint(basis.passage)))?.review ?? null;
}

/** Be told when a review lands, so a chip already on screen can show it. */
export function subscribeReviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forget reviews held in memory (a document closing). What is on disk stays. */
export function clearReviews(path?: string): void {
  if (path === undefined) {
    reviews.clear();
    stampByPath.clear();
  } else {
    for (const k of [...reviews.keys()]) if (k.startsWith(`${path}\n`)) reviews.delete(k);
    stampByPath.delete(path);
  }
  notifyReviews();
}

export interface ReviewItem extends ReviewBasis {
  claim: string;
  quote: string;
}

export function reviewPrompt(items: readonly ReviewItem[]): string {
  const blocks = items
    .map(
      (r, i) => `Citation ${i + 1}
${r.wholePage ? `Page ${r.page} (the quoted words are not on it word for word; this is the page's text):` : `Passage (page ${r.page}):`}
"""
${r.passage.slice(0, MAX_PASSAGE)}
"""
The answer quoted from it: "${r.quote}"
The sentence to check:
"""
${r.claim}
"""`,
    )
    .join("\n\n");
  return `You are checking sentences of an answer against the passages of a document they cite. Decide each one only from its own passage.

${blocks}

For every citation, give its number as item, and:

verdict:
- "supports": the passage states what the sentence says — the same figures, parties, conditions and polarity.
- "contradicts": the passage says something different — another figure, the other party, a missing condition, the opposite.
- "insufficient": the passage neither states nor contradicts it.

reason: one short sentence in the sentence's own language, quoting the words of the passage your verdict turns on.`;
}

/**
 * Ask the reader's model about these citations in one call. Resolves to one
 * entry per item: the review, or null for an item the answer left out or
 * answered twice — one bad entry never discards the others. Throws when
 * there is no key or the call fails.
 */
export async function askModel(
  items: readonly ReviewItem[],
  signal?: AbortSignal,
): Promise<(ClaimReview | null)[]> {
  const settings = await loadSettings();
  assertApiKeyForAgent(settings);
  const { object, usage } = await generateObject({
    model: resolveModel(settings),
    schema: claimReviewBatchSchema,
    prompt: reviewPrompt(items),
    abortSignal: signal,
  });
  addIndexUsage(usage);
  const byItem = new Map<number, ClaimReview | null>();
  for (const r of object.reviews) {
    const review = { verdict: r.verdict, reason: r.reason.slice(0, MAX_REASON) };
    byItem.set(r.item, byItem.has(r.item) ? null : review);
  }
  return items.map((_, i) => byItem.get(i + 1) ?? null);
}

export interface ReviewOutcome {
  counts: Record<ReviewVerdict, number>;
  failed: number;
  /** Stopped by `signal` before every item was asked about. */
  cancelled: boolean;
}

/**
 * Review the items not already reviewed, `REVIEW_BATCH` per call, stopping at
 * once when `signal` aborts — the document closed or the answer went away — so
 * no further billed call is made for it (16.0, B12). Verdicts are kept in
 * memory and written to disk after each call that lands.
 */
export async function reviewAll(
  path: string,
  items: readonly ReviewItem[],
  signal: AbortSignal,
  ask: typeof askModel = askModel,
): Promise<ReviewOutcome> {
  const counts: Record<ReviewVerdict, number> = { supports: 0, contradicts: 0, insufficient: 0 };
  let failed = 0;
  const pending: ReviewItem[] = [];
  for (const r of items) {
    const hit = cachedReview(path, r.claim, r.quote, r);
    if (hit) counts[hit.verdict] += 1;
    else pending.push(r);
  }
  for (let i = 0; i < pending.length; i += REVIEW_BATCH) {
    if (signal.aborted) return { counts, failed, cancelled: true };
    const chunk = pending.slice(i, i + REVIEW_BATCH);
    let answers: (ClaimReview | null)[];
    try {
      answers = await ask(chunk, signal);
    } catch {
      if (signal.aborted) return { counts, failed, cancelled: true };
      failed += chunk.length;
      continue;
    }
    // Asked for a document that has since closed: not kept for it (16.0).
    if (signal.aborted) return { counts, failed, cancelled: true };
    chunk.forEach((r, j) => {
      const review = answers[j];
      if (!review) {
        failed += 1;
        return;
      }
      const fp = passageFingerprint(r.passage);
      reviews.set(key(path, r.claim, r.quote, r.page, fp), { claim: r.claim, quote: r.quote, page: r.page, fp, review });
      counts[review.verdict] += 1;
    });
    notifyReviews();
    await saveReviews(path).catch(() => {});
  }
  return { counts, failed, cancelled: false };
}

/** One citation — the batch path with a batch of one. */
export async function reviewClaim(
  path: string,
  claim: string,
  quote: string,
  passage: string,
  page: number,
  signal?: AbortSignal,
): Promise<ClaimReview> {
  const basis = { page, passage };
  const hit = cachedReview(path, claim, quote, basis);
  if (hit) return hit;
  const controller = new AbortController();
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const { failed, cancelled } = await reviewAll(path, [{ claim, quote, ...basis }], controller.signal);
  const review = cachedReview(path, claim, quote, basis);
  if (cancelled) throw new DOMException("Review cancelled", "AbortError");
  if (failed > 0 || !review) throw new Error("review failed");
  return review;
}

// --- On disk ------------------------------------------------------------

const STORE_FILE = "claim-reviews.json";
const STORE_KEY = "reviews";
const STORE_VERSION = 1;
/** Kept per document, and documents kept: a cache of the model's words, oldest first out. */
export const MAX_REVIEWS_PER_DOC = 500;
export const MAX_REVIEW_DOCS = 100;

interface StoredEntry extends ClaimReview {
  claim: string;
  quote: string;
  /** Since 22.0. An entry without them (21.0's) read an unknown passage and is not read back. */
  page: number;
  fp: string;
}
interface StoredDoc {
  path: string;
  /** The file's stamp when these were asked; another stamp means another file. */
  stamp: string;
  savedAt: number;
  entries: StoredEntry[];
}

const runtime = createStoreRuntime(() => createAtomicStore(STORE_FILE));
/** The stamp each open document was loaded with — what its reviews are written beside. */
const stampByPath = new Map<string, string>();

function isVerdict(v: unknown): v is ReviewVerdict {
  return v === "supports" || v === "contradicts" || v === "insufficient";
}

/** Stored documents, or `newer: true` for a file a later PageWise wrote. */
async function readStored(): Promise<{ docs: StoredDoc[]; newer: boolean }> {
  const s = await runtime.store();
  const raw = (await s.get<unknown>(STORE_KEY)) as { version?: unknown; docs?: unknown } | null | undefined;
  if (!raw || typeof raw !== "object") return { docs: [], newer: false };
  if (typeof raw.version === "number" && raw.version > STORE_VERSION) return { docs: [], newer: true };
  if (raw.version !== STORE_VERSION || !Array.isArray(raw.docs)) return { docs: [], newer: false };
  const docs: StoredDoc[] = [];
  for (const d of raw.docs as Partial<StoredDoc>[]) {
    if (typeof d?.path !== "string" || typeof d.stamp !== "string" || !Array.isArray(d.entries)) continue;
    const entries = d.entries.filter(
      (e): e is StoredEntry =>
        typeof e?.claim === "string" &&
        typeof e.quote === "string" &&
        typeof e.page === "number" &&
        typeof e.fp === "string" &&
        isVerdict(e.verdict) &&
        typeof e.reason === "string",
    );
    docs.push({ path: d.path, stamp: d.stamp, savedAt: Number(d.savedAt) || 0, entries });
  }
  return { docs, newer: false };
}

/**
 * Bring a document's kept verdicts back when it opens, if the file is the one
 * they were asked about. A failed read is no reviews — never an error that
 * blocks opening a document.
 */
export async function loadReviews(path: string, stamp: string): Promise<void> {
  if (!stamp) return;
  stampByPath.set(path, stamp);
  try {
    const { docs } = await runtime.withStoreLock(readStored);
    const doc = docs.find((d) => d.path === path && d.stamp === stamp);
    if (!doc || stampByPath.get(path) !== stamp) return;
    for (const e of doc.entries) {
      reviews.set(key(path, e.claim, e.quote, e.page, e.fp), {
        claim: e.claim,
        quote: e.quote,
        page: e.page,
        fp: e.fp,
        review: { verdict: e.verdict, reason: e.reason },
      });
    }
    notifyReviews();
  } catch {
    // A cache miss: the reader can ask again.
  }
}

/** Write a document's verdicts beside its stamp. Unknown stamp: not written. */
async function saveReviews(path: string): Promise<void> {
  const stamp = stampByPath.get(path);
  if (!stamp) return;
  const prefix = `${path}\n`;
  const entries: StoredEntry[] = [];
  for (const [k, { claim, quote, page, fp, review }] of reviews) {
    if (k.startsWith(prefix)) entries.push({ claim, quote, page, fp, ...review });
  }
  await runtime.withStoreLock(async () => {
    const { docs, newer } = await readStored();
    // A later PageWise's file is not written by this one (21.0, batch 1).
    if (newer) {
      reportStoreProblem(STORE_FILE, "newer");
      return;
    }
    const others = docs.filter((d) => d.path !== path);
    const mine: StoredDoc = { path, stamp, savedAt: Date.now(), entries: entries.slice(-MAX_REVIEWS_PER_DOC) };
    const kept = [...others.sort((a, b) => a.savedAt - b.savedAt), mine].slice(-MAX_REVIEW_DOCS);
    const s = await runtime.store();
    await s.set(STORE_KEY, { version: STORE_VERSION, docs: kept });
    await s.save();
  });
}

/** Test seam — drop memory and the store handle. */
export function __resetClaimReviewsForTests(): void {
  reviews.clear();
  stampByPath.clear();
  runtime.resetStore();
  runtime.resetLock();
}
