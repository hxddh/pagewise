export const OPEN_DOC_SEARCH_EVENT = "pagewise:open-doc-search";

export function requestOpenDocSearch(): void {
  window.dispatchEvent(new CustomEvent(OPEN_DOC_SEARCH_EVENT));
}
