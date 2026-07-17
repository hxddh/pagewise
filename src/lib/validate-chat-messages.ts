import { safeValidateUIMessages, type UIMessage } from "ai";
import type { ProviderId } from "./types";
import {
  dropEmptyPartMessages,
  stripUserFileParts,
} from "./messages-utils";
import { sanitizeDanglingToolParts } from "./prune-chat-history";

function prepareForValidation(
  messages: UIMessage[],
  provider: ProviderId,
): UIMessage[] {
  // sanitizeDanglingToolParts may remove never-completed tool parts, so drop
  // any message it leaves empty (validateUIMessages rejects `parts: []`).
  return dropEmptyPartMessages(
    sanitizeDanglingToolParts(
      stripUserFileParts(dropEmptyPartMessages(messages), provider),
    ),
  );
}

/** Drop a trailing assistant row that still has no user-visible content. */
function dropTrailingEmptyAssistant(messages: UIMessage[]): UIMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return messages;

  const hasContent = last.parts.some((part) => {
    if (part.type === "text" || part.type === "reasoning") {
      return (part.text?.trim().length ?? 0) > 0;
    }
    if (part.type.startsWith("tool-")) return true;
    return false;
  });

  return hasContent ? messages : messages.slice(0, -1);
}

/**
 * Repair and validate chat history before send. Uses `safeValidateUIMessages` and
 * progressively repairs corrupt rows (dangling tools, empty assistants) instead
 * of failing the whole conversation after stop/quit mid-stream.
 */
export async function validateChatMessagesForSend<UI_MESSAGE extends UIMessage>({
  messages,
  provider,
  tools,
}: {
  messages: UI_MESSAGE[];
  provider: ProviderId;
  tools?: Parameters<typeof safeValidateUIMessages<UI_MESSAGE>>[0]["tools"];
}): Promise<UI_MESSAGE[]> {
  let prepared = prepareForValidation(messages, provider) as UI_MESSAGE[];

  for (let attempt = 0; attempt < 6 && prepared.length > 0; attempt++) {
    const result = await safeValidateUIMessages<UI_MESSAGE>({
      messages: prepared,
      tools,
    });
    if (result.success) return result.data;

    const next = dropTrailingEmptyAssistant(
      dropEmptyPartMessages(sanitizeDanglingToolParts(prepared)),
    ) as UI_MESSAGE[];
    if (next.length === prepared.length) {
      // Last-resort repair: drop the newest row that ISN'T a user turn. The
      // trailing row at send time is the message the user just typed — slicing
      // it off would silently swallow their question and re-answer the previous
      // one. If only user rows remain and they still don't validate, fail loudly
      // instead of losing data.
      let dropIdx = prepared.length - 1;
      while (dropIdx >= 0 && prepared[dropIdx]?.role === "user") dropIdx -= 1;
      if (dropIdx < 0) break;
      prepared = [
        ...prepared.slice(0, dropIdx),
        ...prepared.slice(dropIdx + 1),
      ] as UI_MESSAGE[];
    } else {
      prepared = next;
    }
  }

  throw new Error("Chat history could not be repaired for send");
}
