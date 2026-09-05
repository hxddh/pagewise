/**
 * How far a finding can be trusted, in one word.
 *
 * Until 12.0 a finding carried four trust signals that never met. `struck`
 * and `supersedes` were read by the model context; `stamp` was read by a
 * banner over the record panel; the placement of its quote was read by the
 * panel and the page layer. The 11.0 review found the consequence three
 * times over: a claim whose file had changed, or whose wording could not be
 * found, was still sent to the model as *known*, with an instruction not to
 * re-read the page. The panel warned the reader and told the model nothing.
 *
 * This is the one place the four are combined, and every consumer — the
 * panel, the record note, the exported brief — reads the result rather than
 * the signals. A state the panel shows is a state the model is told and a
 * state the export files under; they cannot drift apart because there is
 * nothing to drift.
 *
 * The order below is the order of confidence, and it is also the order the
 * brief lists them in.
 */
import type { Finding } from "./finding-store";
import type { FindingPlacement } from "./finding-anchors";

export type Trust =
  /** The reader said so — by confirming the claim or by rewriting it. */
  | "confirmed"
  /** The quoted wording is on the page it cites, in the file that is open. */
  | "located"
  /** Nothing to check against: no quote, or one too short to mean anything. */
  | "unverified"
  /** The page has text and the quoted wording is not in it. */
  | "unlocated"
  /** The cited page has no text layer, or could not be read. */
  | "unreadable"
  /** Written against an earlier version of the file, and not yet re-checked. */
  | "stale"
  /** Struck by the reader, replaced by a revision, or citing a page past the end. */
  | "retracted";

export interface TrustContext {
  /** The open file's stamp, or "" when unknown — an empty stamp never makes anything stale. */
  stamp: string;
  /** Page count of the open document; 0 when unknown. */
  totalPages: number;
  /** Every finding for the document, so supersession can be seen. */
  all: readonly Finding[];
  /** What the page said about this finding's quote, or null if not looked yet. */
  placement: FindingPlacement | null;
}

/** States the model may be told as known. Everything else is not. */
export const TRUST_KNOWN: ReadonlySet<Trust> = new Set(["confirmed", "located", "unverified"]);

/** States the model is told to re-check before relying on. */
export const TRUST_DOUBTFUL: ReadonlySet<Trust> = new Set(["unlocated", "unreadable", "stale"]);

export function trustOf(finding: Finding, ctx: TrustContext): Trust {
  if (finding.struck) return "retracted";
  if (ctx.all.some((f) => f.supersedes === finding.id)) return "retracted";
  if (ctx.totalPages > 0 && finding.pages.some((p) => p > ctx.totalPages)) return "retracted";
  // A reader's word outranks a file change: confirming is exactly what
  // "re-check" asks for, so a confirmation made on this version of the file
  // settles it. One made before the file changed does not.
  if (finding.confirmedAt && (!ctx.stamp || finding.stamp === ctx.stamp)) return "confirmed";
  if (ctx.stamp && finding.stamp !== ctx.stamp) return "stale";
  if (finding.confirmedAt) return "confirmed";
  switch (ctx.placement?.status) {
    case "located":
      return "located";
    case "absent":
      return "unlocated";
    case "unreadable":
      return "unreadable";
    default:
      return "unverified";
  }
}

/** Whether a reader can usefully press "I checked this" on an entry in this state. */
export function trustNeedsReader(trust: Trust): boolean {
  return TRUST_DOUBTFUL.has(trust) || trust === "unverified";
}
