import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { cachedReview, subscribeReviews } from "../lib/claim-review";
import { useI18n } from "../i18n";
import { cachedCitationCheck, checkCitation, withClaim, type CitationCheck } from "../lib/citation-check";
import { citationLabel, type CitationLink } from "../lib/remark-citations";
import type { PdfRect } from "../lib/types";

/**
 * What a citation needs from the panel it is drawn in: the document it cites,
 * and how to turn to a page. Absent where no document is open, and then a
 * citation is drawn as plain text — there is nothing to check it against.
 */
export interface CitationEnv {
  path: string;
  totalPages: number;
  /** Turn to `page`; with `rects`, light up where the words are. */
  onReveal: (page: number, rects: PdfRect[] | null) => void;
}

export const CitationContext = createContext<CitationEnv | null>(null);

export type CitationChipStatus = CitationCheck["status"] | "pending";

/**
 * One citation in an answer, and whether its words are on its page.
 *
 * The chip is the page number, set small against the sentence it supports,
 * in the colour of what the check found. The quote itself is not shown inline
 * — an answer with every passage quoted twice reads as a wall — but it is the
 * chip's title, and clicking turns to the page with the words lit.
 *
 * The check runs once per citation per open document (`citation-check.ts`),
 * so a chip re-created by every streamed chunk costs nothing after the first.
 */
export function CitationChip({ link, children }: { link: CitationLink; children?: ReactNode }) {
  const env = useContext(CitationContext);
  const { t } = useI18n();
  const [check, setCheck] = useState<CitationCheck | null>(() => (env ? cachedCitationCheck(env.path, link) : null));
  const pagesKey = link.pages.join(",");

  useEffect(() => {
    if (!env) return;
    let live = true;
    setCheck(cachedCitationCheck(env.path, link));
    checkCitation(env.path, env.totalPages, link).then(
      (c) => live && setCheck(c),
      () => undefined,
    );
    return () => {
      live = false;
    };
    // `link` is rebuilt on every render from its URL; its content is the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env?.path, env?.totalPages, pagesKey, link.quote]);
  // `link.claim` does not change what is checked, only how it is read.

  // The model's reading, when the reader asked for one (15.0). Shown beside
  // the local verdict, never in place of it. Subscribed before any early
  // return: a hook after one breaks when the document arrives (16.0, B11).
  const review = useSyncExternalStore(subscribeReviews, () =>
    env && link.quote && link.claim ? cachedReview(env.path, link.claim, link.quote) : null,
  );

  const label = children ?? citationLabel(link.pages);
  if (!env) return <sup className="cite cite-inert">{label}</sup>;

  // Read against the sentence it supports: a number the passage does not state
  // turns a found quote into a doubted one (15.0).
  const read = withClaim(check, link.claim ?? "", link.quote);
  const status: CitationChipStatus = read?.status ?? "pending";
  const pages = citationLabel(link.pages);
  const verdict = t(`cite.${status}`, {
    page: String(read?.page ?? link.pages[0]),
    pages,
    numbers: (read?.unstated ?? []).join("、"),
  });
  const reviewLine = review ? `\n${t(`cite.review.${review.verdict}`)}: ${review.reason}` : "";
  const title = (link.quote ? `“${link.quote}”\n${verdict}` : verdict) + reviewLine;

  return (
    // raw-button: an inline mark inside a sentence — it has to sit on the text line, not read as a control
    <button
      type="button"
      className={`cite cite-${status}${review ? ` cite-review-${review.verdict}` : ""}`}
      title={title}
      aria-label={title}
      onClick={() =>
        env.onReveal(read?.page ?? link.pages[0]!, read?.rects ?? null)
      }
    >
      {label}
    </button>
  );
}
