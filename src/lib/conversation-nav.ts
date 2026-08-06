/**
 * Moving through a conversation with the keyboard.
 *
 * The command palette covers every global action, but inside the conversation
 * there was nothing: the only way to reach an earlier answer was the mouse.
 * Long document sessions are exactly where that hurts — twenty turns in, the
 * answer you want to re-read is far above the fold.
 *
 * The arrow keys alone belong to the composer (they move the caret), so this is
 * bound with a modifier. Kept pure and separate from the DOM so the wrap-around
 * and empty-list behaviour can be tested without rendering a conversation.
 */

export type NavDirection = "prev" | "next";

/**
 * The message to move to, or null when there is nowhere to go.
 *
 * Deliberately does NOT wrap around. Wrapping means Alt+Up at the top of a long
 * conversation silently jumps to the newest message, which reads as the view
 * losing your place rather than as reaching the end.
 */
export function nextMessageId(
  ids: readonly string[],
  currentId: string | null,
  direction: NavDirection,
): string | null {
  if (ids.length === 0) return null;

  // Nothing focused yet: "prev" starts from the newest message, which is what
  // the reader is looking at; "next" has nowhere to go from there.
  if (currentId === null || !ids.includes(currentId)) {
    return direction === "prev" ? (ids[ids.length - 1] ?? null) : null;
  }

  const index = ids.indexOf(currentId);
  const target = direction === "prev" ? index - 1 : index + 1;
  if (target < 0 || target >= ids.length) return null;
  return ids[target] ?? null;
}

/**
 * Move focus one message, given the list element the rows live in.
 *
 * Takes the DOM rather than living inside the component so the behaviour that
 * actually ships can be tested — a test that re-implements the handler proves
 * only that the test is self-consistent.
 *
 * Returns true when focus moved, so the caller knows whether to consume the
 * key event.
 */
export function moveConversationFocus(
  list: HTMLElement,
  direction: NavDirection,
): boolean {
  const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-message-id]"));
  if (rows.length === 0) return false;

  const ids = rows.map((row) => row.dataset.messageId ?? "");
  const active = list.ownerDocument.activeElement as HTMLElement | null;
  const currentRow = active?.closest?.("[data-message-id]") as HTMLElement | null;
  const target = nextMessageId(ids, currentRow?.dataset.messageId ?? null, direction);
  if (!target) return false;

  const row = rows[ids.indexOf(target)];
  if (!row) return false;
  row.focus();
  row.scrollIntoView?.({ block: "nearest" });
  return true;
}
