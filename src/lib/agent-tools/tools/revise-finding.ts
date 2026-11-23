import { tool } from "ai";
import { z } from "zod";
import * as R from "../reading";
import { placeFinding } from "../../finding-anchors";
import {
  reviseFinding,
  resolveFindingId,
  findingHandle,
  MAX_CLAIM_TEXT,
  MAX_EVIDENCE_TEXT,
} from "../../finding-store";

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
        const path = R.activeDocPath(options);
        const doc = R.requireLoadedDoc(path);
        const outOfRange = R.pagesOutOfRange(pages, doc);
        if (outOfRange) return { revised: false, reason: outOfRange };
        // The record note names findings by a short handle rather than a full
        // uuid, so what comes back is usually a prefix. An exact id still
        // resolves to itself; an ambiguous prefix resolves to nothing, and the
        // refusal below is the same one an unknown id gets.
        const resolved = resolveFindingId(path, id);
        const finding =
          resolved === null
            ? null
            : reviseFinding(path, resolved, {
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
        const placement = finding.evidence
          ? await placeFinding(path, finding).catch(() => null)
          : null;
        const verification =
          placement?.status === "located"
            ? ("located" as const)
            : placement?.status === "absent"
              ? ("unlocated" as const)
              : placement?.status === "mismatch"
                ? ("mismatch" as const)
                : undefined;
        return {
          revised: true,
          id: findingHandle(finding.id),
          replaced: findingHandle(finding.supersedes ?? ""),
          pages: finding.pages,
          ...(verification ? { verification } : {}),
          ...(placement?.status === "mismatch" && placement.unstated.length > 0
            ? {
                unstated: placement.unstated,
                note: `Revised, but "${placement.unstated.join(", ")}" in claim conflicted with or was absent from the quoted passage — call revise_finding again if inaccurate.`,
              }
            : placement?.status === "absent"
              ? {
                  note: "Revised, but `evidence` was not found verbatim on the cited page(s) — verify exact wording.",
                }
              : {}),
        };
      },
    ),
  });
}
