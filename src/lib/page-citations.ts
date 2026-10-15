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
 *
 * Since 20.0 there is a second reading of the same citations: the margin
 * column (`columnEntries`) draws one entry per *sentence* that cites a page,
 * with the state of that sentence's evidence — see `answerNotesByPage`. The
 * dots stay one per answer; the column is sentence-level, because a sentence is
 * what a check can be about.
 */
import type { UIMessage } from "ai";
import { extractCitations, type Citation } from "./citations";
import { sentenceStates, type SentenceReason, type SentenceState } from "./answer-sentences";
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

/** One sentence of an answer, as the margin column draws it beside its page. */
export interface AnswerNote {
  messageId: string;
  /** 1-based page this sentence cited. */
  page: number;
  /** The sentence's words: Markdown decoration and citation markers removed. */
  text: string;
  /** The sentence's state (20.0): the five of `answer-sentences.ts`. */
  state: SentenceState;
  /** What put the sentence in its state — the worst marker's reason. */
  reason: SentenceReason;
  /** For a `mismatch`: the numbers the passage does not state, as written. */
  unstated?: string[];
  /** The markers behind the sentence, in the order they appear. */
  citations: Citation[];
}

/**
 * The margin column's entries per page: every sentence of every answer that
 * cites that page, with the state its evidence put it in.
 *
 * A sentence citing several pages is one entry per page — it talks about each
 * of them — and the same sentence never lands twice on the same page. Read
 * from the sentence table the footer counts (`answer-sentences.ts`), so the
 * column, the line under the answer and the record's "keep the verified
 * sentences" all speak of the same sentences.
 */
export function answerNotesByPage(
  path: string,
  messages: readonly UIMessage[],
): Map<number, AnswerNote[]> {
  const out = new Map<number, AnswerNote[]>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const text = visibleText(message);
    if (!text) continue;
    for (const row of sentenceStates(path, text)) {
      const pages = new Set<number>();
      for (const citation of row.sentence.citations) {
        for (const page of citation.pages) pages.add(page);
      }
      for (const page of pages) {
        const list = out.get(page) ?? [];
        list.push({
          messageId: message.id,
          page,
          text: row.sentence.text,
          state: row.state,
          reason: row.reason,
          ...(row.unstated ? { unstated: row.unstated } : {}),
          citations: row.sentence.citations,
        });
        out.set(page, list);
      }
    }
  }
  return out;
}
