/**
 * Telling the model that this document's printed numbers differ from its order.
 *
 * Two halves, deliberately split by what they cost.
 *
 * `read_pdf_page`'s description says the `label` argument EXISTS. That sits in
 * the tool block, which is the cached prefix, so it is paid on every request by
 * every reader — including the great majority whose documents number their
 * pages the obvious way. It is one sentence for that reason.
 *
 * This is the other half: whether the document in front of the reader RIGHT NOW
 * is one of the unusual ones. It rides on the user message with the rest of the
 * volatile context, so it never invalidates the prefix, and it is empty for
 * every document that does not need it.
 */
import { docCache } from "./doc-cache";
import { describeLabels } from "./page-labels";
import { DOCUMENT_OUTLINE_TOOL } from "./document-tool-names";

export function labelHintFor(path: string | null): string {
  if (!path) return "";
  const doc = docCache.get(path);
  const parts: string[] = [];

  const labels = describeLabels(doc?.pageLabels ?? null);
  if (labels) parts.push(labels);

  // That the document carries somebody else's notes, and where to read them.
  // A pointer rather than the notes: they go in `document_outline`'s output,
  // which the model pays for only when it asks.
  const notes = doc?.annotations?.length ?? 0;
  if (notes > 0) {
    parts.push(
      `This document carries ${notes} note${notes === 1 ? "" : "s"} written on it by ` +
        `whoever sent it — highlights and comments. ${DOCUMENT_OUTLINE_TOOL} lists them; ` +
        `they are worth reading before deciding which pages matter.`,
    );
  }

  return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
}
