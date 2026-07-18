import type { UIMessage } from "ai";
import { Store } from "@tauri-apps/plugin-store";
import { prepareMessagesForPersist } from "../lib/persist-messages";
import { hydrateChatMessages, normalizeUIMessages } from "../lib/messages-utils";

const STORE_PATH = "pagewise-v3-chats.json";

function chatKey(path: string): string {
  return path;
}

let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load(STORE_PATH).catch((err) => {
      storePromise = null;
      throw err;
    });
  }
  return storePromise;
}

// Serialize every mutation so a 500ms autosave, a document-switch save, a
// close-flush, and a clear can't interleave their set/delete + save cycles and
// resurrect a just-cleared chat via last-write-wins (mirrors allowed-paths.ts).
let storeLock: Promise<unknown> = Promise.resolve();
function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = storeLock.then(fn, fn);
  storeLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function loadChat(path: string): Promise<UIMessage[]> {
  const store = await getStore();
  const raw = await store.get<unknown>(chatKey(path));
  // Normalize before hydrating: a malformed persisted row (torn write, legacy
  // shape) must degrade to "skip that row", never throw — a throw here would
  // surface as a document-open failure.
  const messages = normalizeUIMessages(raw);
  if (messages.length === 0) return [];
  return hydrateChatMessages(messages);
}

export async function saveChat(path: string, messages: UIMessage[]): Promise<void> {
  return withStoreLock(async () => {
    const store = await getStore();
    await store.set(chatKey(path), prepareMessagesForPersist(messages));
    await store.save();
  });
}

export async function clearChat(path: string): Promise<void> {
  return withStoreLock(async () => {
    const store = await getStore();
    await store.delete(chatKey(path));
    await store.save();
  });
}

/**
 * Bound the chat store's growth WITHOUT deleting history for a document the
 * user might reopen. The store keys chats by absolute path and never evicts, so
 * over months it would accumulate every chat ever opened. But the recent-files
 * list is capped at 10, so pruning everything outside it (the pre-v3.5.15
 * behavior) deleted the chat of the 11th-most-recent document — real history
 * loss for anyone who opens more than a handful of files.
 *
 * Instead: always keep chats for the current recents, and only trim when the
 * store exceeds a generous cap, dropping the oldest NON-recent keys until it
 * fits. A user must open more than `maxChats` distinct documents before any
 * non-recent chat is dropped. Best-effort — a failure must never block startup.
 */
const MAX_STORED_CHATS = 100;

export async function pruneOrphanedChats(
  keepPaths: string[],
  maxChats = MAX_STORED_CHATS,
): Promise<void> {
  try {
    await withStoreLock(async () => {
      const store = await getStore();
      const keys = await store.keys();
      if (keys.length <= maxChats) return;
      const keep = new Set(keepPaths);
      // keys() preserves insertion order → oldest first. Drop the oldest keys
      // that aren't in recents until we're under the cap.
      const droppable = keys.filter((k) => !keep.has(k));
      const dropCount = Math.min(droppable.length, keys.length - maxChats);
      if (dropCount <= 0) return;
      for (const k of droppable.slice(0, dropCount)) await store.delete(k);
      await store.save();
    });
  } catch {
    /* best-effort cleanup */
  }
}
