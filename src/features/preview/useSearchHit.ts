import { useEffect, useState } from "react";

/** Where the reader landed from a search, and what they were looking for. */
export interface SearchHit {
  page: number;
  query: string;
}

/**
 * The search hit currently worth marking on the page — remembered only while
 * the reader is still on the page they jumped to.
 *
 * `PreviewPane` held this as plain state and said in a comment that it was
 * "cleared as soon as they navigate away from it". Nothing cleared it. The
 * highlight draws only on its own page, so it was invisible while the reader
 * was elsewhere and looked harmless — and then painted itself again every time
 * they scrolled back past that page, for the rest of the session, with no
 * search running and nothing on screen to explain it.
 *
 * The forgetting lives here rather than in the component because it is the
 * whole of the rule: a component holding `useState` plus an effect somewhere
 * further down is a rule anyone can drop by accident, and — as the marks bug
 * in 9.2.3 showed — a mis-wiring that type-checks is one nothing catches.
 */
export function useSearchHit(page: number) {
  const [hit, setHit] = useState<SearchHit | null>(null);

  useEffect(() => {
    // Functional update, and `page` as the only dependency: this must run when
    // the READER moves, never when the hit itself is set. A jump sets the page
    // and the hit together, and this has to not eat the highlight it was just
    // handed.
    setHit((current) => (current && current.page !== page ? null : current));
  }, [page]);

  return [hit, setHit] as const;
}
