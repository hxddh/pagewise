import { createContext, useContext, type ReactNode } from "react";
import type { UIMessage } from "ai";

/**
 * What the one search can look at beyond the document.
 *
 * ⌘F is one overlay with two halves — this document and this conversation —
 * and the overlay is mounted by the preview pane (it is positioned over the
 * page it searches), which has no idea a conversation exists. The panel's
 * messages and the way to reach a turn arrive through this scope, provided by
 * the app; when there is no conversation, the search simply has one section.
 */
export interface SearchScope {
  messages: UIMessage[];
  /** Bring a turn into view — opens the panel when it is closed. */
  gotoMessage: (id: string) => void;
}

const SearchScopeContext = createContext<SearchScope | null>(null);

export function SearchScopeProvider({
  value,
  children,
}: {
  value: SearchScope;
  children: ReactNode;
}) {
  return <SearchScopeContext.Provider value={value}>{children}</SearchScopeContext.Provider>;
}

export function useSearchScope(): SearchScope | null {
  return useContext(SearchScopeContext);
}

/**
 * Put a turn of the conversation in front of the reader.
 *
 * The message list is rendered by the chat panel, but the overlay that points
 * at it is mounted by the preview pane, so the two cannot share a ref. The
 * rows already carry `data-message-id` (the panel's own Alt+Up/Down and the
 * record's reveal both use it); this is the same lookup from outside.
 */
export function focusMessageRow(id: string): boolean {
  const row = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
  if (!row) return false;
  row.scrollIntoView({ block: "center" });
  row.focus({ preventScroll: true });
  return true;
}
