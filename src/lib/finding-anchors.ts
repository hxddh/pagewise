/**
 * Findings, placed on the page.
 *
 * `locateQuote` does the finding; this decides where the work happens and who
 * pays for it. Two surfaces need the same answer — the layer that draws a
 * finding on the page, and the record panel that says whether its evidence
 * checks out — and if each resolved its own, they would fetch the same page's
 * runs twice and could disagree about the same claim. `chargedAttachments` is
 * the same lesson: assembly lives in one place so two readers cannot each grow
 * their own idea of what a page holds.
 *
 * RESOLVED, NEVER STORED. A located rectangle is not written back into the
 * finding. A stored rectangle goes stale silently: the file changes, the quote
 * is now on a different page or gone, and a persisted anchor keeps pointing
 * confidently at whatever now occupies those coordinates. Re-deriving it costs
 * one already-cached IPC call per page and is correct by construction.
 *
 * FOUR OUTCOMES, NOT THREE, since 12.0. Until then a page whose runs could not
 * be read — a scan with no text layer, or an IPC failure — was folded into an
 * empty list, and an empty list made every quote "absent". The record panel
 * then said *this wording is not on the page it cites* about a citation the
 * app had never been able to check. That is the one sentence in the product
 * that must never be wrong, and it was wrong for every scanned page.
 * `unreadable` is the honest fourth answer: nothing was confirmed, nothing was
 * doubted, and the reader can still turn to the page and look.
 *
 * The cache is keyed on path and page and cleared when the document does, so a
 * document reopened after an edit resolves against the file that is actually
 * open. The most recent placement of each finding is also kept, by id, so a
 * synchronous caller — the record note built at send time — can read what the
 * panel already worked out without an IPC call of its own.
 */
import { pageTextItems } from "./pdf";
import { ocrEnabled, ocrPage } from "./ocr/ocr-service";
import { docCache } from "./doc-cache";
import { locateQuote, unionRect, type LocateOutcome } from "./quote-locate";
import type { Finding } from "./finding-store";
import type { PdfRect, TextItemRect } from "./types";

export interface FindingAnchor {
  /** The page the quote was found on — always one of the finding's own pages. */
  page: number;
  /** One rectangle per text run the quote spans. */
  rects: PdfRect[];
  /** All of them as one, for placing a margin note beside the passage. */
  bounds: PdfRect;
}

export type FindingPlacement =
  /** The evidence was found, on the page it was attributed to. */
  | { status: "located"; anchor: FindingAnchor }
  /** Every cited page has text, and the wording is on none of them. */
  | { status: "absent" }
  /**
   * Not in the words OCR recognised on a scanned page (14.0). Recognition can
   * misread, so this is not "absent": the reader is told to look, not that
   * the evidence is wrong.
   */
  | { status: "unconfirmed" }
  /** No evidence to check, or too little of it to mean anything. */
  | { status: "uncheckable" }
  /** No cited page could be read: no text layer, or the runs failed to load. */
  | { status: "unreadable" };

/** A page's runs, and why they might be empty. */
export interface PageRuns {
  items: TextItemRect[];
  /** `ok` may still carry an empty list: a page with no text layer. */
  reason: "ok" | "failed";
  /**
   * `ocr` when the runs are words local OCR recognised on a scan, not the
   * page's own text layer. A quote absent from them may be a misreading.
   */
  source?: "text" | "ocr";
}

/**
 * A scanned page's recognised words, when there is no text layer. Only a PDF
 * page has somewhere to put them — an image document's OCR is text only.
 */
async function recognisedRuns(path: string, page: number): Promise<PageRuns | null> {
  if (!ocrEnabled() || docCache.get(path)?.kind !== "pdf") return null;
  const read = await ocrPage(path, page);
  if (!read || read.items.length === 0) return null;
  return { items: read.items, reason: "ok", source: "ocr" };
}

const itemCache = new Map<string, Promise<PageRuns>>();
const placementCache = new Map<string, FindingPlacement>();

function key(path: string, page: number | string): string {
  return `${path} ${page}`;
}

/** A page's text runs, fetched once per open document. */
export function pageRuns(path: string, page: number): Promise<PageRuns> {
  const cacheKey = key(path, page);
  const hit = itemCache.get(cacheKey);
  if (hit) return hit;
  const pending = pageTextItems(path, page).then(
    async (items): Promise<PageRuns> => {
      if (items.length > 0) return { items, reason: "ok", source: "text" };
      // No text layer: a scan. Its recognised words stand in, so a citation
      // on it can be checked and highlighted (14.0).
      const recognised = await recognisedRuns(path, page);
      if (recognised) return recognised;
      // Not cached as empty while OCR is on: the page may be read later.
      if (ocrEnabled()) itemCache.delete(cacheKey);
      return { items, reason: "ok", source: "text" };
    },
    () => {
      // Dropped from the cache so a transient failure is not permanent — and
      // reported as a failure, not as an empty page. See the file comment.
      itemCache.delete(cacheKey);
      return { items: [] as TextItemRect[], reason: "failed" as const };
    },
  );
  itemCache.set(cacheKey, pending);
  return pending;
}

/** Drop cached runs and placements. Called when the open document changes. */
export function clearFindingAnchors(path?: string): void {
  if (path === undefined) {
    itemCache.clear();
    placementCache.clear();
    return;
  }
  const prefix = `${path} `;
  for (const k of [...itemCache.keys()]) if (k.startsWith(prefix)) itemCache.delete(k);
  for (const k of [...placementCache.keys()]) if (k.startsWith(prefix)) placementCache.delete(k);
}

/**
 * The last placement resolved for this finding, if any surface has asked.
 *
 * Synchronous on purpose: the record note is assembled inside `prepareCall`,
 * which cannot wait on IPC. `null` means "not looked yet", and the caller
 * treats that as unverified rather than as anything stronger.
 */
export function cachedPlacement(path: string, findingId: string): FindingPlacement | null {
  return placementCache.get(key(path, findingId)) ?? null;
}

/**
 * Place one finding.
 *
 * Only the pages the finding itself cites are searched, in the order it listed
 * them. Widening the search to the whole document would convert the single most
 * useful failure — a claim attributed to the wrong page — into a confident
 * highlight somewhere else.
 *
 * "absent" needs every cited page to have been searched and come back with
 * text and no match; "uncheckable" wins over both when there was nothing to
 * look for; "unreadable" is what is left when no page could be searched at
 * all. A quote that is absent from one readable page and unreadable on another
 * is reported as unreadable: one page that could not be checked is enough to
 * withhold the accusation.
 */
export async function placeFinding(path: string, finding: Finding): Promise<FindingPlacement> {
  const placement = await resolvePlacement(path, finding);
  placementCache.set(key(path, finding.id), placement);
  return placement;
}

async function resolvePlacement(path: string, finding: Finding): Promise<FindingPlacement> {
  const quote = finding.evidence.trim();
  if (!quote) return { status: "uncheckable" };

  let sawAbsent = false;
  let sawUnreadable = false;
  let sawRecognised = false;
  for (const page of finding.pages) {
    const runs = await pageRuns(path, page);
    const outcome: LocateOutcome = locateQuote(runs.items, quote);
    if (outcome.status === "located") {
      const bounds = unionRect(outcome.rects);
      if (bounds) return { status: "located", anchor: { page, rects: outcome.rects, bounds } };
    }
    if (outcome.status === "uncheckable") return { status: "uncheckable" };
    if (outcome.status === "absent") {
      sawAbsent = true;
      if (runs.source === "ocr") sawRecognised = true;
    }
    if (outcome.status === "unreadable") sawUnreadable = true;
  }
  if (sawUnreadable) return { status: "unreadable" };
  // One page searched only through recognised words is enough to withhold
  // the accusation, as one unreadable page is.
  if (sawRecognised) return { status: "unconfirmed" };
  return sawAbsent ? { status: "absent" } : { status: "uncheckable" };
}

/**
 * Resolve every active finding of a document once, so the record note has
 * placements to read on the first question after opening. Best-effort and
 * unawaited by its caller: a placement that has not come back yet is simply
 * unverified for that one turn.
 */
export function prewarmPlacements(path: string, findings: readonly Finding[]): Promise<void> {
  return Promise.all(findings.map((f) => placeFinding(path, f).catch(() => undefined))).then(
    () => undefined,
  );
}
