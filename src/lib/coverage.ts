/**
 * Pages an answer did not read that the question points at (15.0).
 *
 * The checks on an answer's citations say whether what it states holds. They
 * cannot say what it left out — and an answer to "list every penalty" that
 * read three pages of a forty-page contract looks exactly as complete as one
 * that read all forty. The pages it read are known (`read-pages.ts`); the
 * pages whose words match the reader's question are not hard to find. The
 * difference is worth one line under the answer.
 *
 * Lexical, local and free. Not every word of the question counts: "列出合同中
 * 所有的违约金条款" is mostly phrasing. The words that count are the question's
 * words that the pages the answer read also contain — what the answer turned
 * out to be about. An unread page carrying at least half of them is offered.
 * It misses a page that says the same thing in other words (the evaluation
 * measures how often), and it never claims a page is relevant, only that it
 * matches.
 *
 * Offered only where leaving pages out matters: a question that asks for all
 * of something, or an answer laid out as a table. "What does page 3 say?"
 * read what it needed.
 */
import { tokenize } from "./ranked-search";
import { markdownToPlainText } from "./markdown-text";
import type { PageText } from "./types";

/** Questions that ask for everything of a kind. */
const EXHAUSTIVE =
  /\b(all|every|each|any|list|which|what are|how many|enumerate|summari[sz]e)\b|所有|全部|每一|每个|每项|哪些|列出|列举|多少|有几|汇总|总结|清单/i;

export const MAX_UNREAD_SUGGESTIONS = 3;

export function asksForEverything(question: string, answer = ""): boolean {
  return EXHAUSTIVE.test(question) || /^\s*\|.*\|\s*$/m.test(answer);
}

/**
 * Unread pages that match `question`, best first; [] when the answer read
 * every page, read none, or the question is not one where omissions matter.
 */
export function unreadRelevantPages(
  pages: readonly PageText[],
  question: string,
  readPages: readonly number[],
  answer = "",
): number[] {
  if (!question.trim() || readPages.length === 0) return [];
  if (!asksForEverything(question, answer)) return [];
  return rankUnreadPages(pages, question, readPages);
}

/** The ranking itself, without the "does this question ask for everything" gate. */
export function rankUnreadPages(pages: readonly PageText[], question: string, readPages: readonly number[]): number[] {
  const read = new Set(readPages);
  const termsByPage = new Map(pages.map((p) => [p.page, new Set(tokenize(markdownToPlainText(p.text)))]));
  const unread = pages.filter((p) => !read.has(p.page) && p.text.trim());
  if (unread.length === 0) return [];

  const readTerms = new Set(pages.filter((p) => read.has(p.page)).flatMap((p) => [...termsByPage.get(p.page)!]));
  const asked = [...new Set(tokenize(question))];
  // The question's words the answer's own pages carry; all of them when the
  // pages it read carry none (a question it could not find at all).
  const focus = asked.filter((t) => readTerms.has(t));
  const terms = focus.length > 0 ? focus : asked;
  if (terms.length === 0) return [];
  const need = Math.max(1, Math.ceil(terms.length / 2));

  // Rarer terms say more: weighted by how few pages of the document carry them.
  const weight = new Map(
    terms.map((t) => {
      let df = 0;
      for (const set of termsByPage.values()) if (set.has(t)) df += 1;
      return [t, Math.log(1 + pages.length / Math.max(1, df))];
    }),
  );
  return unread
    .map((p) => {
      const has = termsByPage.get(p.page)!;
      const matched = terms.filter((t) => has.has(t));
      return { page: p.page, matched: matched.length, score: matched.reduce((n, t) => n + weight.get(t)!, 0) };
    })
    .filter((h) => h.matched >= need)
    .sort((a, b) => b.score - a.score || a.page - b.page)
    .slice(0, MAX_UNREAD_SUGGESTIONS)
    .map((h) => h.page);
}
