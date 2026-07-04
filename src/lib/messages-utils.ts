import type { UIMessage } from "ai";

/** Find the last message matching predicate without allocating a reversed copy. */
export function findLastMessage(
  messages: UIMessage[],
  predicate: (m: UIMessage) => boolean,
): UIMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && predicate(m)) return m;
  }
  return undefined;
}
