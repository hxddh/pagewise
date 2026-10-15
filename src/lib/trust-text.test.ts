import { describe, expect, it } from "vitest";
import type { CitationStatus } from "./citation-check";
import type { Trust } from "./finding-trust";
import { TRUST_TEXT, briefReasons, longKey, reviewReasons } from "./trust-text";
import { citationLevel, recordLevel } from "./trust-level";

/** Every trust the record works out, in `finding-trust.ts`'s order. */
const TRUSTS: readonly Trust[] = [
  "confirmed",
  "located",
  "unverified",
  "unlocated",
  "mismatch",
  "unreadable",
  "unconfirmed",
  "stale",
  "retracted",
];

/** Every state a citation's check can end in, plus `pending`. */
const STATUSES: readonly (CitationStatus | "pending")[] = [
  "located",
  "unlocated",
  "unreadable",
  "unconfirmed",
  "mismatch",
  "unchecked",
  "tooShort",
  "outOfRange",
  "pending",
];

/** The reason a sentence with no marker reads (20.0). */
const NO_MARKER = "noMarker" as const;

/**
 * The words and the levels must stay one answer.
 *
 * The chip is coloured by `trust-level.ts` and says its reason from
 * `trust-text.ts`; a table that reads "not found" for something trust-level
 * calls a check is the drift the table exists to stop, and nothing else would
 * notice it.
 */
describe("the trust table", () => {
  it("gives every reason the level trust-level.ts gives it", () => {
    for (const trust of TRUSTS) {
      expect(TRUST_TEXT[trust].level, trust).toBe(recordLevel(trust));
    }
    for (const status of STATUSES) {
      expect(TRUST_TEXT[status].level, status).toBe(citationLevel(status));
    }
    expect(TRUST_TEXT[NO_MARKER].level).toBe("none");
  });

  it("reads every reason in both catalogs, not as the key it asked for", () => {
    for (const locale of ["en", "zh-CN"] as const) {
      for (const [trust, said] of Object.entries(briefReasons(locale))) {
        expect(said.trim().length, `${locale} ${trust}`).toBeGreaterThan(0);
        expect(said, `${locale} ${trust}: a key that did not resolve`).not.toMatch(/^trust\./);
      }
      // The model's reading is filed by the CSV and the brief; both languages
      // must say it, labelled as the model's.
      for (const [verdict, said] of Object.entries(reviewReasons(locale))) {
        expect(said.trim().length, `${locale} ${verdict}`).toBeGreaterThan(0);
        expect(said, `${locale} ${verdict}: a key that did not resolve`).not.toMatch(/^cite\./);
      }
    }
  });

  it("has a sentence for every trust and a one-line label for every status", () => {
    for (const trust of TRUSTS) expect(longKey(trust), trust).toMatch(/^trust\./);
    for (const status of STATUSES) expect(TRUST_TEXT[status].short, status).toBeTruthy();
    for (const trust of TRUSTS.filter((t) => t !== "retracted")) {
      expect(TRUST_TEXT[trust].brief ?? TRUST_TEXT[trust].long, trust).toMatch(/^trust\./);
    }
    // The word for a sentence nothing says the origin of: "not checked".
    expect(longKey(NO_MARKER)).toMatch(/^trust\./);
  });
});
