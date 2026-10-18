export const OPEN_DOC_SEARCH_EVENT = "pagewise:open-doc-search";

/** What an open request may carry: words to put in the field (24.0). */
export interface OpenDocSearchDetail {
  query?: string;
}

/**
 * Open the one search. With `query`, the field opens holding it — a red
 * citation chip's "search the document for this text" (24.0) — so the reader
 * lands on results rather than an empty input they have to retype into.
 */
export function requestOpenDocSearch(query?: string): void {
  window.dispatchEvent(
    new CustomEvent<OpenDocSearchDetail>(OPEN_DOC_SEARCH_EVENT, { detail: query ? { query } : {} }),
  );
}
