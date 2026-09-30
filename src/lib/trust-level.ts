/**
 * What a reader is told about a citation or a record entry: one of three
 * levels (16.0).
 *
 * Underneath there are eight citation statuses and nine record trusts, each
 * precise about why — the words were found, a number in the sentence was not,
 * the page is a scan OCR may have misread, the page is past the end. All of
 * that is still worked out, exported and fed back to the model. But a reader
 * deciding whether to trust a sentence needs one of three answers:
 *
 *   - verified — the words are on the page (or the reader said so);
 *   - check    — look at the page yourself: the words may be there, the
 *                claim about them is in doubt, or nothing could be read;
 *   - notFound — the words are not on the page, or the page does not exist.
 *
 * Plus "none", for a citation with nothing to check (no quote) or not
 * checked yet: no claim is made either way.
 *
 * One table, so the chip, the tally, the record and the CSV cannot drift.
 */
import type { CitationCheck } from "./citation-check";
import type { ReviewVerdict } from "./claim-review";
import type { Trust } from "./finding-trust";

export type TrustLevel = "verified" | "check" | "notFound" | "none";

export const TRUST_LEVELS: readonly Exclude<TrustLevel, "none">[] = ["verified", "check", "notFound"];

type CitationStatus = CitationCheck["status"] | "pending";

const CITATION: Record<CitationStatus, TrustLevel> = {
  located: "verified",
  mismatch: "check",
  unconfirmed: "check",
  unreadable: "check",
  unlocated: "notFound",
  outOfRange: "notFound",
  unchecked: "none",
  pending: "none",
};

/**
 * The level of one citation. The model's review, when the reader asked for
 * one, can only lower it: a passage the model reads as saying otherwise is
 * not a verified citation, but a model agreeing never outranks the local
 * check — the words must still be on the page.
 */
export function citationLevel(status: CitationStatus, review?: ReviewVerdict | null): TrustLevel {
  const level = CITATION[status];
  if (review === "contradicts" && level !== "none") return "notFound";
  return level;
}

const RECORD: Record<Trust, TrustLevel> = {
  confirmed: "verified",
  located: "verified",
  mismatch: "check",
  unconfirmed: "check",
  unreadable: "check",
  stale: "check",
  unlocated: "notFound",
  retracted: "notFound",
  unverified: "none",
};

export function recordLevel(trust: Trust): TrustLevel {
  return RECORD[trust];
}

/** Citations counted by level, for the line under an answer. */
export function countLevels(statuses: Iterable<TrustLevel>): Record<TrustLevel, number> {
  const out: Record<TrustLevel, number> = { verified: 0, check: 0, notFound: 0, none: 0 };
  for (const s of statuses) out[s] += 1;
  return out;
}
