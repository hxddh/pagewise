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
 *
 * TWO LISTS, NOT ONE, since 12.0. Until then every finding that was neither
 * struck nor superseded went out under "treat these as known" — including
 * ones written against a version of the file that no longer exists, and ones
 * whose quoted wording the page had been searched for and did not carry. The
 * panel showed the reader a warning; the model was told the opposite. Now the
 * same `trustOf` the panel reads decides which list a finding is in, and the
 * doubtful list asks for exactly what the panel asks the reader for: read the
 * page again before relying on it.
 */
import { activeFindings, findingHandle, getFindings, type Finding } from "./finding-store";
import { sanitizeForPrompt } from "./agent-view-context";
import { cachedPlacement } from "./finding-anchors";
import { docCache } from "./doc-cache";
import { TRUST_DOUBTFUL, TRUST_KNOWN, trustOf, type Trust } from "./finding-trust";

/**
 * How much of the record one question may carry.
 *
 * A document may hold up to 500 findings; sending all of them would replace one
 * unbounded cost with another. 2,000 characters is roughly 500 tokens — under a
 * third of what a single 6,000-character page read costs, which is the trade
 * this whole mechanism exists to make.
 */
export const RECORD_CHAR_BUDGET = 2_000;

/**
 * One line per claim: its handle, then the pages, then what was established.
 *
 * The handle is what makes `revise_finding` callable at all. Its schema takes
 * "the finding being replaced", and before this the record note named no
 * finding — it listed claims and pages and then told the agent to correct them
 * with a tool that needs an identifier it had never been given. The final
 * sentence of this note has always asked for a correction; this is the first
 * version where the agent can make one.
 *
 * The pages stay immediately beside the claim so the anchor is never separated
 * from it. See `FINDING_HANDLE_LEN` for why the handle is short rather than a
 * full uuid — it is paid on every question, for every claim.
 */
function renderFinding(finding: Finding): string {
  return `- [${findingHandle(finding.id)}] p${finding.pages.join(",")}: ${sanitizeForPrompt(
    finding.claim,
    300,
  )}`;
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
): { lines: string[]; omitted: number; used: number } {
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
  return { lines: kept.map(renderFinding), omitted: findings.length - kept.length, used };
}

/** The trust of every active finding, from what the app knows right now. */
export function trustedFindings(path: string): Array<{ finding: Finding; trust: Trust }> {
  const doc = docCache.get(path);
  const all = getFindings(path);
  return activeFindings(path).map((finding) => ({
    finding,
    trust: trustOf(finding, {
      stamp: doc?.stamp ?? "",
      totalPages: doc?.totalPages ?? 0,
      all,
      placement: cachedPlacement(path, finding.id),
    }),
  }));
}

function omittedTail(omitted: number): string {
  return omitted > 0
    ? `\n(${omitted} older entr${omitted === 1 ? "y" : "ies"} not shown; read the pages if you need them.)`
    : "";
}

/**
 * The record note for this turn, or "" when there is nothing established yet.
 *
 * Struck, superseded and out-of-range claims are excluded by `trustOf`
 * returning `retracted` — the reader's correction and the assistant's own
 * revision both have to actually take effect here, or the record becomes a
 * memory that cannot be corrected. Stale, unlocated and unreadable claims go
 * out under a different heading with the opposite instruction.
 */
export function buildRecordInstructions(path: string | null): string {
  if (!path) return "";
  const rated = trustedFindings(path);
  const known = rated.filter((r) => TRUST_KNOWN.has(r.trust)).map((r) => r.finding);
  const doubtful = rated.filter((r) => TRUST_DOUBTFUL.has(r.trust)).map((r) => r.finding);
  if (known.length === 0 && doubtful.length === 0) return "";

  let out = "";
  let budget = RECORD_CHAR_BUDGET;

  if (known.length > 0) {
    const { lines, omitted, used } = selectFindingsForPrompt(known, budget);
    budget -= used;
    if (lines.length > 0) {
      out +=
        `\n\nAlready established about this document, from earlier questions:\n` +
        `${lines.join("\n")}${omittedTail(omitted)}\n` +
        `Treat these as known. Do not re-read those pages just to work them out again — ` +
        `read when the question needs text you do not have, or when you suspect one of ` +
        `these is wrong, and then use revise_finding with the id in brackets to correct it.`;
    }
  }

  if (doubtful.length > 0) {
    const { lines, omitted } = selectFindingsForPrompt(doubtful, Math.max(budget, 0));
    if (lines.length > 0) {
      out +=
        `\n\nEarlier entries that need re-checking before you rely on them — the file ` +
        `changed since they were written, or their quoted wording could not be found on ` +
        `the page they cite:\n` +
        `${lines.join("\n")}${omittedTail(omitted)}\n` +
        `Do not treat these as established. If the question depends on one, read the ` +
        `cited page first; then use revise_finding with the id in brackets to restate it ` +
        `from what the page says now, or to correct it.`;
    }
  }

  return out;
}
