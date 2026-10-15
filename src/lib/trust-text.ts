/**
 * The one table of words for what a citation or a record entry turned out to
 * be — the reason behind the level the reader is given (16.0).
 *
 * `trust-level.ts` owns the three answers — verified, check, not found — and
 * works out which one a citation's check or a record's trust lands on. The
 * words under them were four parallel sets, one per reader: the chip's
 * tooltip (`cite.<status>`), the record's line (`record.trust*`), the CSV's
 * "Checked" column (`table.status*`), and the exported brief's reason, which
 * was written out in TypeScript and so was invisible to check-i18n-keys.
 *
 * Same reason, said once. The table is keyed by the internal status and names
 * the i18n key for each of the three readings:
 *
 *   - `short` — one line, for the CSV beside the words it was found from;
 *   - `long`  — the sentence the reader is shown: the chip's tooltip, the
 *               line under a claim in the record;
 *   - `brief` — the reason as the exported brief files it.
 *
 * A reason with nothing of its own to add to its sentence — "nothing to check
 * against" is the same line in the brief — names no `brief`, and the brief
 * reads `long`. The words themselves stay in `i18n/locales`, so both
 * languages move together, and every one of them is a key the checker sees.
 *
 * `level` is the one thing here `trust-level.ts` already knows; the test
 * beside this file holds the two together, because a reason that says "check
 * the page" while the chip is coloured ✗ is the drift this module exists to
 * stop.
 */
import en from "../i18n/locales/en.json";
import zhCN from "../i18n/locales/zh-CN.json";
import type { Locale } from "../i18n";
import type { CitationStatus } from "./citation-check";
import type { ReviewVerdict } from "./claim-review";
import type { Trust } from "./finding-trust";
import type { TrustLevel } from "./trust-level";

/** What a citation's check can end in, plus `pending` while it is still running. */
export type CitationReason = CitationStatus | "pending";

/**
 * Everything the app can say about why: the nine trusts the record works out
 * (`finding-trust.ts`), the nine a citation's check can end in
 * (`citation-check.ts`), and `noMarker` — a sentence of an answer with no
 * marker at all (20.0), whose word is "not checked".
 */
export type TrustReason = Trust | CitationReason | "noMarker";

export interface TrustText {
  /** Which of the three words the reader is shown, once this reason is worked out. */
  level: TrustLevel;
  /** i18n key: the one-line label. Citation statuses only — the record's lines are sentences. */
  short?: string;
  /** i18n key: the reason as the sentence the reader is shown. */
  long: string;
  /** i18n key: the reason as the exported brief files it; `long` when it has none of its own. */
  brief?: string;
}

export const TRUST_TEXT: Record<TrustReason, TrustText> = {
  confirmed: { level: "verified", long: "trust.confirmed.long", brief: "trust.confirmed.brief" },
  located: {
    level: "verified",
    short: "trust.located.short",
    long: "trust.located.long",
    brief: "trust.located.brief",
  },
  unverified: { level: "none", long: "trust.unverified.long" },
  unlocated: { level: "notFound", short: "trust.unlocated.short", long: "trust.unlocated.long" },
  mismatch: {
    level: "check",
    short: "trust.mismatch.short",
    long: "trust.mismatch.long",
    brief: "trust.mismatch.brief",
  },
  unreadable: {
    level: "check",
    short: "trust.unreadable.short",
    long: "trust.unreadable.long",
    brief: "trust.unreadable.brief",
  },
  unconfirmed: {
    level: "check",
    short: "trust.unconfirmed.short",
    long: "trust.unconfirmed.long",
    brief: "trust.unconfirmed.brief",
  },
  stale: { level: "check", long: "trust.stale.long", brief: "trust.stale.brief" },
  retracted: { level: "notFound", long: "trust.retracted.long" },
  unchecked: { level: "none", short: "trust.unchecked.short", long: "trust.unchecked.long" },
  tooShort: { level: "none", short: "trust.tooShort.short", long: "trust.tooShort.long" },
  noMarker: {
    level: "none",
    short: "trust.noMarker.short",
    long: "trust.noMarker.long",
  },
  outOfRange: { level: "notFound", short: "trust.outOfRange.short", long: "trust.outOfRange.long" },
  pending: { level: "none", short: "trust.pending.short", long: "trust.pending.long" },
};

/** The sentence the reader is shown for a reason — the chip's tooltip, the record's line. */
export function longKey(reason: TrustReason): string {
  return TRUST_TEXT[reason].long;
}

/** The one-line label of a check or a sentence's state, for a chip or a card. */
export function shortKey(reason: TrustReason): string {
  return TRUST_TEXT[reason].short ?? TRUST_TEXT[reason].long;
}

/** A trust as the exported brief files it. */
export function briefKey(trust: Exclude<Trust, "retracted">): string {
  return TRUST_TEXT[trust].brief ?? TRUST_TEXT[trust].long;
}

/**
 * The reason lines the brief files each trust under, in the reader's
 * language. `export-brief.ts` runs outside React, so the words are read from
 * the catalogs directly; they carry no placeholders, and so need no filling.
 */
export function briefReasons(locale: Locale): Record<Exclude<Trust, "retracted">, string> {
  return {
    confirmed: said(locale, briefKey("confirmed")),
    located: said(locale, briefKey("located")),
    unverified: said(locale, briefKey("unverified")),
    unlocated: said(locale, briefKey("unlocated")),
    mismatch: said(locale, briefKey("mismatch")),
    unreadable: said(locale, briefKey("unreadable")),
    unconfirmed: said(locale, briefKey("unconfirmed")),
    stale: said(locale, briefKey("stale")),
  };
}

/**
 * The model's reading of a citation, as the exported CSV and brief file it —
 * always labelled as the model's (`cite.review.*`, the same words the chip
 * shows beside the local verdict), never as a local check. The verdict is the
 * reader's own, asked for by hand and kept in memory only, so an export made
 * after the document was reopened has no verdicts to file: nothing else is
 * persisted.
 */
export function reviewReasons(locale: Locale): Record<ReviewVerdict, string> {
  return {
    supports: said(locale, "cite.review.supports"),
    contradicts: said(locale, "cite.review.contradicts"),
    insufficient: said(locale, "cite.review.insufficient"),
  };
}

const CATALOGS: Record<Locale, unknown> = { en, "zh-CN": zhCN };

/** The words a key holds; the key itself, as `t` does, when a catalog lacks it. */
function said(locale: Locale, key: string): string {
  let words: unknown = CATALOGS[locale];
  for (const part of key.split(".")) {
    words = words && typeof words === "object" ? (words as Record<string, unknown>)[part] : undefined;
  }
  return typeof words === "string" ? words : key;
}
