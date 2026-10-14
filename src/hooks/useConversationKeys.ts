import { useCallback } from "react";
import type { RefObject } from "react";
import { moveConversationFocus } from "../lib/conversation-nav";

/**
 * Getting around a conversation without the mouse: Alt+Up/Down walks it a turn
 * at a time, moving focus onto a whole turn. It lives here rather than in the
 * panel because the panel is where features go to become 900 lines. The find
 * chord used to be its other half — the panel's own search bar — and since
 * 19.0 there is one search for the whole workspace (⌘F).
 */

export interface ConversationKeys {
  /** Put this on the panel root, not the message list — see the chord below. */
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export function useConversationKeys(
  listRef: RefObject<HTMLDivElement | null>,
  /** Cleared when the reader navigates away from the newest message. */
  stickToBottomRef: RefObject<boolean>,
): ConversationKeys {
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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

  return { onKeyDown };
}
