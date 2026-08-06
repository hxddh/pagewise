import type { UIMessage } from "ai";

/**
 * Finding something you already read, in a conversation you have scrolled past.
 *
 * Twenty turns into a document session the answer worth re-reading is far above
 * the fold, and until now the only way back to it was the mouse — 7.3 added
 * Alt+Up/Down, which walks one turn at a time and is no help when you remember
 * a word rather than a position.
 *
 * Deliberately not fuzzy. A reader searching their own conversation is looking
 * for a phrase they remember seeing; ranking that by edit distance turns an
 * exact recollection into a guess. Case-insensitive substring is what the
 * browser's own find does, and it is what people expect.
 */

export interface MessageMatch {
  id: string;
  /** Where in the visible text the first hit falls — for scrolling to it. */
  index: number;
  /** Enough surrounding text to recognise the hit without opening the turn. */
  excerpt: string;
}

const EXCERPT_BEFORE = 30;
const EXCERPT_AFTER = 60;

/**
 * The text of a message as the reader sees it.
 *
 * Only `text` parts. Reasoning is collapsed behind a fold and tool results are
 * machinery — matching them would send the reader to a turn where the word they
 * searched for is nowhere visible.
 */
export function visibleText(message: UIMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const text = parts
    .filter((p): p is { type: "text"; text: string } => p?.type === "text")
    .map((p) => p.text)
    .join("\n");
  if (text) return text;
  const legacy = (message as { content?: unknown }).content;
  return typeof legacy === "string" ? legacy : "";
}

export function searchMessages(
  messages: readonly UIMessage[],
  query: string,
): MessageMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const out: MessageMatch[] = [];
  for (const message of messages) {
    const text = visibleText(message);
    const index = text.toLowerCase().indexOf(needle);
    if (index < 0) continue;
    const from = Math.max(0, index - EXCERPT_BEFORE);
    const to = Math.min(text.length, index + needle.length + EXCERPT_AFTER);
    out.push({
      id: message.id,
      index,
      excerpt: `${from > 0 ? "…" : ""}${text.slice(from, to).trim()}${to < text.length ? "…" : ""}`,
    });
  }
  return out;
}

/**
 * The match to move to, wrapping at both ends.
 *
 * Wrapping is right here and wrong for Alt+Up/Down: stepping through a search's
 * hits is a closed loop the reader is cycling deliberately, whereas walking the
 * conversation is movement along it, where being thrown to the other end reads
 * as losing your place.
 */
export function stepMatch(
  matches: readonly MessageMatch[],
  current: number,
  direction: 1 | -1,
): number {
  if (matches.length === 0) return -1;
  const next = current + direction;
  if (next < 0) return matches.length - 1;
  if (next >= matches.length) return 0;
  return next;
}
