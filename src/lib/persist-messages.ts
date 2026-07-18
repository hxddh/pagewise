import type { UIMessage } from "ai";
import { dropEmptyPartMessages, stripStaleScreenshotParts } from "./messages-utils";
import {
  pruneToolOutputsForHistory,
  sanitizeDanglingToolParts,
} from "./prune-chat-history";

/** Sanitize dangling tools and compact bulky tool outputs before writing to disk. */
export function prepareMessagesForPersist(messages: UIMessage[]): UIMessage[] {
  // Never persist stale page screenshots — multi-MB base64 that would also be
  // re-hydrated and re-sent on the next turn.
  return dropEmptyPartMessages(
    stripStaleScreenshotParts(sanitizeDanglingToolParts(pruneToolOutputsForHistory(messages))),
  );
}
