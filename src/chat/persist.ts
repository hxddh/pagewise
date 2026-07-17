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
 * Drop persisted chats whose document is no longer in the keep-set (recent
 * files). The store keys chats by absolute path and never evicts otherwise, so
 * months of use would accumulate every chat ever opened, all loaded into memory
 * by the store plugin. Best-effort — a failure here must never block startup.
 */
export async function pruneOrphanedChats(keepPaths: string[]): Promise<void> {
  try {
    await withStoreLock(async () => {
      const store = await getStore();
      const keep = new Set(keepPaths);
      const keys = await store.keys();
      const stale = keys.filter((k) => !keep.has(k));
      if (stale.length === 0) return;
      for (const k of stale) await store.delete(k);
      await store.save();
    });
  } catch {
    /* best-effort cleanup */
  }
}
