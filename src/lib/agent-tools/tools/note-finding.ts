import { tool } from "ai";
import { z } from "zod";
import * as R from "../reading";
import {
  addFinding,
  findingHandle,
  MAX_CLAIM_TEXT,
  MAX_EVIDENCE_TEXT,
} from "../../finding-store";

/**
 * The `note_finding` tool — the first one that writes.
 *
 * THE DESCRIPTION IS SHORT ON PURPOSE. Tool descriptions and schemas are the
 * expensive half of the cached prompt prefix — ~736 tokens for the six readers,
 * measured — and every word here is paid on every question by every reader,
 * whether or not the record is ever used. `agent-tool-prefix.test.ts` pins the
 * digest so the cost cannot drift silently. The saving this enables is
 * conditional (it lands only when pages are revisited); the cost is not.
 *
 * `pages` is required and must be non-empty. A claim the reader cannot trace
 * back to a page is the one thing this record must never contain, so the schema
 * refuses it rather than the store dropping it later.
 *
 * Nothing is charged to the read budget: that budget exists to cap how much of
 * the document one run may pull into context, and writing pulls nothing.
 */
export function createNoteFindingTool() {
  return tool({
    description:
      "Record something you established about the document, so later questions " +
      "do not have to re-read the same pages. Cite the pages it came from.",
    inputSchema: z.object({
      pages: z
        .array(z.number().int().min(1))
        .min(1)
        .describe("Pages the claim came from"),
      claim: z.string().min(1).max(MAX_CLAIM_TEXT).describe("What you established"),
      evidence: z
        .string()
        .max(MAX_EVIDENCE_TEXT)
        .optional()
        .describe("The wording that supports it"),
    }),
    contextSchema: R.docToolContextSchema,
    execute: R.bindToolExecute(
      () => ({ message: "Noting a finding…", key: "agent.activityNoteFinding" }),
      "tool",
      () => 0,
      async ({ pages, claim, evidence }, options) => {
        const path = R.resolvePathInput(undefined, options);
        const doc = R.requireLoadedDoc(path);
        const finding = addFinding(path, {
          pages,
          claim,
          evidence,
          stamp: doc.stamp ?? "",
        });
        if (!finding) {
          // The store's own refusals — cap reached, or nothing usable left after
          // normalizing. Reported rather than thrown: a failed note must not end
          // the run, it just means this one was not kept.
          return { recorded: false, reason: "not recorded (document at its limit, or empty claim)" };
        }
        // The handle, not the uuid: it is the one form the agent ever sees,
        // here and in the record note it is given on later questions, and two
        // spellings of the same identifier is an invitation to quote the wrong
        // one back. `resolveFindingId` accepts either.
        return { recorded: true, id: findingHandle(finding.id), pages: finding.pages };
      },
    ),
  });
}
