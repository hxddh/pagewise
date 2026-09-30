/**
 * An answer's citations, counted by the level the reader sees (16.0).
 *
 * The same reading as each chip: the local check against the sentence the
 * citation stands behind, lowered by a model review the reader asked for.
 * So the line under an answer never says "verified" of a chip showing ✗.
 */
import { claimBefore } from "./answer-tables";
import { cachedCitationCheck, withClaim } from "./citation-check";
import { citationKey, extractCitations } from "./citations";
import { cachedReview } from "./claim-review";
import { citationLevel, countLevels, type TrustLevel } from "./trust-level";

export function answerLevels(path: string, markdown: string): Record<TrustLevel, number> & { total: number } {
  const seen = new Set<string>();
  const levels: TrustLevel[] = [];
  for (const c of extractCitations(markdown)) {
    const k = citationKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    const claim = claimBefore(markdown, c.index);
    const check = withClaim(cachedCitationCheck(path, c), claim, c.quote);
    const review = c.quote && claim ? cachedReview(path, claim, c.quote) : null;
    levels.push(citationLevel(check?.status ?? "pending", review?.verdict));
  }
  return { ...countLevels(levels), total: levels.length };
}
