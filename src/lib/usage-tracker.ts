import type { LanguageModelUsage } from "ai";

export interface IndexUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  /**
   * Vision requests made. Vision is billed per page image, so this is the
   * number that actually describes the spend — tokens alone understate it.
   */
  calls: number;
}

let indexUsage: IndexUsageSnapshot = { inputTokens: 0, outputTokens: 0, calls: 0 };

function addUsage(
  target: IndexUsageSnapshot,
  usage: Pick<LanguageModelUsage, "inputTokens" | "outputTokens"> | undefined,
): void {
  if (!usage) return;
  target.inputTokens += usage.inputTokens ?? 0;
  target.outputTokens += usage.outputTokens ?? 0;
}

export function resetIndexUsageTracker(): void {
  indexUsage = { inputTokens: 0, outputTokens: 0, calls: 0 };
}

export function addIndexUsage(
  usage: Pick<LanguageModelUsage, "inputTokens" | "outputTokens"> | undefined,
): void {
  addUsage(indexUsage, usage);
}

export function getIndexUsageSnapshot(): IndexUsageSnapshot {
  return { ...indexUsage };
}

/**
 * Vision requests sent per document this session.
 *
 * Vision indexing is billed per page image, so the request count — not the token
 * total — is what the user is actually spending. Counted at dispatch: it reports
 * what was sent, which is the number that can surprise someone.
 */
const docVisionCalls = new Map<string, number>();

export function recordVisionCall(path: string): void {
  docVisionCalls.set(path, (docVisionCalls.get(path) ?? 0) + 1);
  indexUsage.calls += 1;
}

export function getVisionCallCount(path: string): number {
  return docVisionCalls.get(path) ?? 0;
}

/**
 * Vision tokens a document accrued outside any run — the on-view prefetch.
 *
 * When the reader scrolls onto a page with no text, the page is sent to vision
 * before any question is asked. It is billed like any other call, but there is
 * no message being written to charge it to, and the per-run tracker is reset by
 * every question — so its tokens used to be dropped on the floor. They are kept
 * per document now, next to the call count `recordVisionCall` already keeps, so
 * what a document has cost is the whole of it (18.0).
 */
const docVisionUsage = new Map<string, IndexUsageSnapshot>();

export function addDocumentVisionUsage(
  path: string,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
): void {
  if (!usage) return;
  const current = docVisionUsage.get(path) ?? { inputTokens: 0, outputTokens: 0, calls: 0 };
  current.inputTokens += usage.inputTokens ?? 0;
  current.outputTokens += usage.outputTokens ?? 0;
  current.calls += 1;
  docVisionUsage.set(path, current);
}

/** What the on-view prefetch alone has spent on this document. */
export function getDocumentVisionUsage(path: string): IndexUsageSnapshot {
  const usage = docVisionUsage.get(path);
  return usage ? { ...usage } : { inputTokens: 0, outputTokens: 0, calls: 0 };
}

/**
 * Forget what one document spent (20.0).
 *
 * Both maps are keyed by path and only ever grew, so they are part of one
 * document's state — and must be closed with it, or the scan-all confirmation
 * for a reopened document shows the previous session's call count (App.tsx)
 * and fifty opened documents leave fifty entries behind. Registered with the
 * document scope.
 */
export function forgetDocumentUsage(path: string): void {
  docVisionCalls.delete(path);
  docVisionUsage.delete(path);
}
