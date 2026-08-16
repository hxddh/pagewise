/**
 * The record, rendered for the model.
 *
 * 9.0 gave the assistant somewhere to write down what it worked out. This is
 * the half that reads it back: what was established about this document comes
 * into the next question, so the run does not have to re-derive it by reading
 * the same pages again.
 *
 * IT RIDES ON THE USER MESSAGE, never on the system prompt. The system block is
 * the first thing every provider caches, and a record that grew by a sentence
 * each turn would invalidate that cache on every question — turning a saving
 * into a permanent loss of the ~1,472-token prefix. `agent.ts` already routes
 * the volatile half of the prompt this way for the same reason; this joins it.
 *
 * WHAT IT DOES NOT DO: stop the agent reading. It says what is already known
 * and asks it not to re-read pages purely to re-derive that. A page is still
 * one tool call away when the question actually needs the text — the record is
 * a memory, not a substitute for the document, and an agent that trusted it
 * over the page would be worse than one that forgets.
 */
import { activeFindings, type Finding } from "./finding-store";
import { sanitizeForPrompt } from "./agent-view-context";

/**
 * How much of the record one question may carry.
 *
 * A document may hold up to 500 findings; sending all of them would replace one
 * unbounded cost with another. 2,000 characters is roughly 500 tokens — under a
 * third of what a single 6,000-character page read costs, which is the trade
 * this whole mechanism exists to make.
 */
export const RECORD_CHAR_BUDGET = 2_000;

/** One line per claim: the pages first, so the anchor is never separated from it. */
function renderFinding(finding: Finding): string {
  return `- p${finding.pages.join(",")}: ${sanitizeForPrompt(finding.claim, 300)}`;
}

/**
 * Select what fits, newest first.
 *
 * Newest rather than oldest because a revision is newer than the claim it
 * corrects by construction: dropping from the recent end would be most likely
 * to drop exactly the corrections, and re-tell the agent something it had
 * already worked out was wrong.
 *
 * The kept lines are then put back into the order they were written, because
 * a record reads as a history.
 */
export function selectFindingsForPrompt(
  findings: readonly Finding[],
  budget = RECORD_CHAR_BUDGET,
): { lines: string[]; omitted: number } {
  const kept: Finding[] = [];
  let used = 0;
  for (let i = findings.length - 1; i >= 0; i -= 1) {
    const finding = findings[i]!;
    const cost = renderFinding(finding).length + 1;
    if (used + cost > budget) break;
    used += cost;
    kept.push(finding);
  }
  kept.reverse();
  return { lines: kept.map(renderFinding), omitted: findings.length - kept.length };
}

/**
 * The record note for this turn, or "" when there is nothing established yet.
 *
 * Struck and superseded claims are already excluded by `activeFindings` — the
 * reader's correction and the assistant's own revision both have to actually
 * take effect here, or the record becomes a memory that cannot be corrected.
 */
export function buildRecordInstructions(path: string | null): string {
  if (!path) return "";
  const findings = activeFindings(path);
  if (findings.length === 0) return "";

  const { lines, omitted } = selectFindingsForPrompt(findings);
  if (lines.length === 0) return "";

  const tail =
    omitted > 0
      ? `\n(${omitted} older entr${omitted === 1 ? "y" : "ies"} not shown; read the pages if you need them.)`
      : "";

  return (
    `\n\nAlready established about this document, from earlier questions:\n` +
    `${lines.join("\n")}${tail}\n` +
    `Treat these as known. Do not re-read those pages just to work them out again — ` +
    `read when the question needs text you do not have, or when you suspect one of ` +
    `these is wrong, and then use revise_finding to correct it.`
  );
}
