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
 * Never automatic. Each citation reviewed is one short, billed call, and the
 * button says how many before anything is sent.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel } from "./llm";
import { loadSettings } from "./settings";
import { assertApiKeyForAgent } from "./llm";
import { addIndexUsage } from "./usage-tracker";

export type ReviewVerdict = "supports" | "contradicts" | "insufficient";

export interface ClaimReview {
  verdict: ReviewVerdict;
  /** One sentence, quoting the words it turned on. */
  reason: string;
}

export const claimReviewSchema = z.object({
  verdict: z.enum(["supports", "contradicts", "insufficient"]),
  reason: z.string(),
});

const MAX_PASSAGE = 3000;
const MAX_REASON = 400;

const reviews = new Map<string, ClaimReview>();
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

function key(path: string, claim: string, quote: string): string {
  return `${path}\n${claim}\n${quote}`;
}

export function cachedReview(path: string, claim: string, quote: string): ClaimReview | null {
  return reviews.get(key(path, claim, quote)) ?? null;
}

/** Be told when a review lands, so a chip already on screen can show it. */
export function subscribeReviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearReviews(path?: string): void {
  if (path === undefined) reviews.clear();
  else for (const k of [...reviews.keys()]) if (k.startsWith(`${path}\n`)) reviews.delete(k);
  notifyReviews();
}

export function reviewPrompt(claim: string, quote: string, passage: string, page: number): string {
  return `You are checking one sentence of an answer against the passage of a document it cites. Decide only from the passage.

Passage (page ${page}):
"""
${passage.slice(0, MAX_PASSAGE)}
"""

The answer quoted from it: "${quote}"

The sentence to check:
"""
${claim}
"""

verdict:
- "supports": the passage states what the sentence says — the same figures, parties, conditions and polarity.
- "contradicts": the passage says something different — another figure, the other party, a missing condition, the opposite.
- "insufficient": the passage neither states nor contradicts it.

reason: one short sentence in the sentence's own language, quoting the words of the passage your verdict turns on.`;
}

/** Ask the reader's model about one citation. Throws when there is no key or the call fails. */
export async function reviewClaim(
  path: string,
  claim: string,
  quote: string,
  passage: string,
  page: number,
  signal?: AbortSignal,
): Promise<ClaimReview> {
  const hit = cachedReview(path, claim, quote);
  if (hit) return hit;
  const settings = await loadSettings();
  assertApiKeyForAgent(settings);
  const { object, usage } = await generateObject({
    model: resolveModel(settings),
    schema: claimReviewSchema,
    prompt: reviewPrompt(claim, quote, passage, page),
    abortSignal: signal,
  });
  addIndexUsage(usage);
  const review: ClaimReview = { verdict: object.verdict, reason: object.reason.slice(0, MAX_REASON) };
  // Asked for a document that has since closed: not kept for it (16.0).
  if (signal?.aborted) throw new DOMException("Review cancelled", "AbortError");
  reviews.set(key(path, claim, quote), review);
  notifyReviews();
  return review;
}

export interface ReviewItem {
  claim: string;
  quote: string;
  passage: string;
  page: number;
}

export interface ReviewOutcome {
  counts: Record<ReviewVerdict, number>;
  failed: number;
  /** Stopped by `signal` before every item was asked about. */
  cancelled: boolean;
}

/**
 * Review each item in turn, stopping at once when `signal` aborts — the
 * document closed or the answer went away — so no further billed call is made
 * for it (16.0, B12).
 */
export async function reviewAll(
  path: string,
  items: readonly ReviewItem[],
  signal: AbortSignal,
  review: typeof reviewClaim = reviewClaim,
): Promise<ReviewOutcome> {
  const counts: Record<ReviewVerdict, number> = { supports: 0, contradicts: 0, insufficient: 0 };
  let failed = 0;
  for (const r of items) {
    if (signal.aborted) return { counts, failed, cancelled: true };
    try {
      const verdict = await review(path, r.claim, r.quote, r.passage, r.page, signal);
      counts[verdict.verdict] += 1;
    } catch {
      if (signal.aborted) return { counts, failed, cancelled: true };
      failed += 1;
    }
  }
  return { counts, failed, cancelled: false };
}
