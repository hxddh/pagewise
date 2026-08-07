import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { UIMessage } from "ai";
import { moveConversationFocus } from "../lib/conversation-nav";
import {
  searchMessages,
  stepMatch,
  type MessageMatch,
} from "../lib/conversation-search";

/**
 * Getting around a conversation without the mouse.
 *
 * Alt+Up/Down walks it a turn at a time; the find chord searches it. These
 * arrived in separate releases and were both written directly into ChatPanel,
 * which two consecutive reviews had said not to split because each of them was
 * about to land there. Both were right and the sum was not: the panel reached
 * 839 lines and became the largest component in the app.
 *
 * They belong together anyway — both move focus onto a whole turn, using the
 * same rows and the same "the reader has left the tail" rule.
 */

export interface ConversationKeys {
  searchOpen: boolean;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  closeSearch: () => void;
  matches: MessageMatch[];
  /** 0-based position in `matches`; -1 when there are none. */
  matchIndex: number;
  gotoMatch: (direction: 1 | -1) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Put this on the panel root, not the message list — see the chord below. */
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export function useConversationKeys(
  messages: readonly UIMessage[],
  listRef: RefObject<HTMLDivElement | null>,
  /** Cleared when the reader navigates away from the newest message. */
  stickToBottomRef: RefObject<boolean>,
): ConversationKeys {
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);

  const matches = useMemo(
    () => (searchOpen ? searchMessages(messages, searchQuery) : []),
    [searchOpen, messages, searchQuery],
  );

  // A new query starts from the newest hit: that is where the reader is.
  useEffect(() => {
    setMatchIndex(matches.length > 0 ? matches.length - 1 : 0);
  }, [matches]);

  const focusMessage = useCallback(
    (id: string) => {
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(id)}"]`,
      );
      if (!row) return;
      row.focus();
      row.scrollIntoView({ block: "center" });
      stickToBottomRef.current = false;
    },
    [listRef, stickToBottomRef],
  );

  const gotoMatch = useCallback(
    (direction: 1 | -1) => {
      const next = stepMatch(matches, matchIndex, direction);
      if (next < 0) return;
      setMatchIndex(next);
      const hit = matches[next];
      if (hit) focusMessage(hit.id);
    },
    [matches, matchIndex, focusMessage],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // The find chord. The document viewer binds the same chord on `window`,
      // so this one must both preventDefault and stopPropagation: the React
      // root sees the event first, and stopping it there is what keeps the two
      // searches from opening together.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
        window.setTimeout(() => searchRef.current?.select(), 0);
        return;
      }
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      const list = listRef.current;
      if (!list) return;
      if (!moveConversationFocus(list, e.key === "ArrowUp" ? "prev" : "next")) return;
      e.preventDefault();
      // Moving to an older message means the reader has left the tail; don't
      // yank them back to the bottom on the next streamed chunk.
      stickToBottomRef.current = false;
    },
    [listRef, stickToBottomRef],
  );

  return {
    searchOpen,
    searchQuery,
    setSearchQuery,
    closeSearch,
    matches,
    matchIndex: matches.length > 0 ? matchIndex : -1,
    gotoMatch,
    searchRef,
    onKeyDown,
  };
}
