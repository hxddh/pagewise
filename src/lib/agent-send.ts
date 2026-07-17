import { isImageInputError } from "./llm";

export type AgentSendPayload = {
  text: string;
  files?: Array<{ type: "file"; mediaType: string; url: string }>;
  messageId?: string;
};

function payloadHasFiles(payload: AgentSendPayload): boolean {
  return (payload.files?.length ?? 0) > 0;
}

/**
 * AI SDK `sendMessage` sets `error` status without throwing — callers must inspect `readError`.
 * On image rejection, drop the optimistic user row and retry text-only once.
 */
export async function sendWithImageFallback(
  payload: AgentSendPayload,
  send: (p: AgentSendPayload) => Promise<void>,
  readError: () => Error | undefined,
  clearError: () => void,
  onRetryWithoutImage: () => void,
  onAfterRetryWithoutImage?: () => void,
): Promise<void> {
  const attempt = async (p: AgentSendPayload): Promise<Error | undefined> => {
    clearError();
    await send(p);
    return readError();
  };

  let err = await attempt(payload);
  if (err && payloadHasFiles(payload) && isImageInputError(err)) {
    // Only roll back the optimistic user row for a NEW send. For an id-based
    // resend (edit/regenerate), sendMessage({messageId}) itself replaces the
    // row — removing it first would make the retry throw "message not found"
    // and permanently delete the user's message.
    if (payload.messageId == null) {
      onRetryWithoutImage();
    }
    onAfterRetryWithoutImage?.();
    err = await attempt({ text: payload.text, messageId: payload.messageId });
  }

  if (err) throw err;
}
