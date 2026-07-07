import type { PageWiseUIMessage } from "../lib/message-metadata";

export interface FlushChatDeps {
  /** Resolve once any in-flight agent stream has settled (or been stopped). */
  waitForStreamIdle: () => Promise<unknown>;
  /** Stop the agent stream. */
  stop: () => void;
  /** Read the current document path (called AFTER the stream is idle). */
  getPath: () => string | undefined;
  /** Read the current messages (called AFTER the stream is idle). */
  getMessages: () => PageWiseUIMessage[];
  /** Cancel any pending debounced autosave so it can't fire a duplicate write. */
  clearAutosave: () => void;
  /** Persist the messages for the given path. */
  saveChat: (path: string, messages: PageWiseUIMessage[]) => Promise<void>;
}

/**
 * Flush the active chat to disk (used on window close and document switch).
 *
 * Ordering matters: it awaits stream idle FIRST, then reads the path and
 * messages, so the just-finished stream tail is persisted rather than a stale
 * pre-abort snapshot (the M3 fix). Skips the write entirely when there is no
 * document or the chat is empty, so a transient empty state during hydration
 * can't clobber a document's saved history.
 */
export async function flushChat(deps: FlushChatDeps): Promise<void> {
  await deps.waitForStreamIdle();
  deps.stop();
  const path = deps.getPath();
  const messages = deps.getMessages();
  if (!path || messages.length === 0) return;
  deps.clearAutosave();
  await deps.saveChat(path, messages);
}
