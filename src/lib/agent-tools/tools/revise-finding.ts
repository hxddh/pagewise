import { tool } from "ai";
import { z } from "zod";
import * as R from "../reading";
import { reviseFinding, MAX_CLAIM_TEXT, MAX_EVIDENCE_TEXT } from "../../finding-store";

/**
 * The `revise_finding` tool.
 *
 * The half of the record that keeps it honest. An agent that can only append
 * accumulates contradictions and leaves the reader to work out which claim to
 * believe; one that could edit in place would leave no trace of having been
 * wrong. This does neither: the old finding stays exactly as written, the new
 * one carries `supersedes` and the reason, and only the correction is told to
 * the agent on the next turn.
 *
 * Short description, same reason as `note_finding` — see the note there.
 */
export function createReviseFindingTool() {
  return tool({
    description:
      "Correct an earlier finding when later reading contradicts it. The old " +
      "one is kept, marked as replaced.",
    inputSchema: z.object({
      id: z.string().min(1).describe("The finding being replaced"),
      pages: z
        .array(z.number().int().min(1))
        .min(1)
        .describe("Pages the corrected claim came from"),
      claim: z.string().min(1).max(MAX_CLAIM_TEXT).describe("The corrected claim"),
      why: z.string().max(MAX_CLAIM_TEXT).optional().describe("Why the earlier one was wrong"),
      evidence: z.string().max(MAX_EVIDENCE_TEXT).optional(),
    }),
    contextSchema: R.docToolContextSchema,
    execute: R.bindToolExecute(
      () => ({ message: "Revising a finding…", key: "agent.activityReviseFinding" }),
      "tool",
      () => 0,
      async ({ id, pages, claim, why, evidence }, options) => {
        const path = R.resolvePathInput(undefined, options);
        const doc = R.requireLoadedDoc(path);
        const finding = reviseFinding(path, id, {
          pages,
          claim,
          why,
          evidence,
          stamp: doc.stamp ?? "",
        });
        if (!finding) {
          // Unknown id, or already revised — revising a revision would fork the
          // record into two live claims, and it is a single timeline by design.
          return {
            revised: false,
            reason: "not revised (no such finding, or it was already replaced)",
          };
        }
        return { revised: true, id: finding.id, replaced: id, pages: finding.pages };
      },
    ),
  });
}
