/**
 * Which page each answer cites, for the margin.
 *
 * A citation in an answer (`〔p12 "…"〕`) is the only place a *turn* is tied to
 * a page. The gutter in the page margin shows those as indigo dots (19.0), so
 * the reader can see that page 12 is not only marked and concluded about but
 * also talked about — and can go back to the sentence that did it.
 *
 * Read from the visible text only: reasoning is folded away and tool results
 * are machinery, the same rule `conversation-search.ts` applies to a search hit.
 * One entry per answer per page: three citations of page 12 in one answer are
 * one dot, because the dot stands for the answer, not the marker.
 */
import type { UIMessage } from "ai";
import { extractCitations } from "./citations";
import { visibleText } from "./conversation-search";

export interface PageCitation {
  messageId: string;
  /** 1-based, one of the pages this answer cited. */
  page: number;
  /** The words the answer quoted for this page, when it quoted any. */
  quote: string | null;
}

/** Pages the conversation's answers cite, ascending by page. */
export function citationsByPage(messages: readonly UIMessage[]): Map<number, PageCitation[]> {
  const out = new Map<number, PageCitation[]>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const text = visibleText(message);
    if (!text) continue;
    for (const citation of extractCitations(text)) {
      for (const page of citation.pages) {
        const list = out.get(page) ?? [];
        if (list.some((c) => c.messageId === message.id)) continue;
        list.push({ messageId: message.id, page, quote: citation.quote });
        out.set(page, list);
      }
    }
  }
  return out;
}
