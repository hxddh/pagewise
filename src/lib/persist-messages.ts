import type { UIMessage } from "ai";
import {
  pruneToolOutputsForHistory,
  sanitizeDanglingToolParts,
} from "./prune-chat-history";

/** Sanitize dangling tools and compact bulky tool outputs before writing to disk. */
export function prepareMessagesForPersist(messages: UIMessage[]): UIMessage[] {
  return sanitizeDanglingToolParts(pruneToolOutputsForHistory(messages));
}
