import type { UIMessage } from "ai";
import { Store } from "@tauri-apps/plugin-store";
import { prepareMessagesForPersist } from "../lib/persist-messages";
import { hydrateChatMessages, normalizeUIMessages } from "../lib/messages-utils";

const STORE_PATH = "pagewise-v3-chats.json";
/**
 * Fingerprint → path, kept beside the chats. A chat is keyed by path because
 * everything in the app addresses a document by path; this index is what lets
 * a renamed file find the chat it had. See `file-identity.ts`.
 */
const IDENTITY_INDEX_KEY = "pagewise:identity-index";

function chatKey(path: string): string {
  return path;
}

async function readIdentityIndex(store: Store): Promise<Record<string, string>> {
  const raw = await store.get<unknown>(IDENTITY_INDEX_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
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

/**
 * The chat for a document — by path, then by fingerprint.
 *
 * A chat found under another path for a file with this content is moved to
 * the path the file has now, so a renamed document opens with its own
 * conversation rather than an empty one.
 */
export async function loadChat(path: string, identity?: string): Promise<UIMessage[]> {
  const store = await getStore();
  let raw = await store.get<unknown>(chatKey(path));
  if ((raw === null || raw === undefined) && identity) {
    const index = await readIdentityIndex(store);
    const oldPath = index[identity];
    if (oldPath && oldPath !== path) {
      const moved = await store.get<unknown>(chatKey(oldPath));
      if (moved !== null && moved !== undefined) {
        raw = moved;
        await withStoreLock(async () => {
          await store.set(chatKey(path), moved);
          await store.delete(chatKey(oldPath));
          await store.set(IDENTITY_INDEX_KEY, { ...index, [identity]: path });
          await store.save();
        });
      }
    }
  }
  // Normalize before hydrating: a malformed persisted row (torn write, legacy
  // shape) must degrade to "skip that row", never throw — a throw here would
  // surface as a document-open failure.
  const messages = normalizeUIMessages(raw);
  if (messages.length === 0) return [];
  return hydrateChatMessages(messages);
}

export async function saveChat(
  path: string,
  messages: UIMessage[],
  identity?: string,
): Promise<void> {
  return withStoreLock(async () => {
    const store = await getStore();
    await store.set(chatKey(path), prepareMessagesForPersist(messages));
    if (identity) {
      const index = await readIdentityIndex(store);
      if (index[identity] !== path) {
        await store.set(IDENTITY_INDEX_KEY, { ...index, [identity]: path });
      }
    }
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
      keep.add(IDENTITY_INDEX_KEY);
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
