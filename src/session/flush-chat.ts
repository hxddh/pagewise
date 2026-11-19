import type { PageWiseUIMessage } from "../lib/message-metadata";

export interface FlushChatDeps {
  /** Resolve once any in-flight agent stream has settled (or been stopped). */
  waitForStreamIdle: () => Promise<unknown>;
  /** Stop the agent stream. */
  stop: () => void;
  /** Read the current document path (called AFTER the stream is idle). */
  getPath: () => string | undefined;
  /** Read the current document content fingerprint, if any. */
  getIdentity?: () => string | undefined;
  /** Read the current messages (called AFTER the stream is idle). */
  getMessages: () => PageWiseUIMessage[];
  /** Cancel any pending debounced autosave so it can't fire a duplicate write. */
  clearAutosave: () => void;
  /** Persist the messages for the given path. */
  saveChat: (path: string, messages: PageWiseUIMessage[], identity?: string) => Promise<void>;
}

export async function flushChat(deps: FlushChatDeps): Promise<void> {
  await deps.waitForStreamIdle();
  deps.stop();
  const path = deps.getPath();
  const messages = deps.getMessages();
  if (!path || messages.length === 0) return;
  deps.clearAutosave();
  const identity = deps.getIdentity?.();
  if (identity !== undefined) {
    await deps.saveChat(path, messages, identity);
  } else {
    await deps.saveChat(path, messages);
  }
}
