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

export function labelHintFor(path: string | null): string {
  if (!path) return "";
  const doc = docCache.get(path);
  const sentence = describeLabels(doc?.pageLabels ?? null);
  return sentence ? `\n\n${sentence}` : "";
}
