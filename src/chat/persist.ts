import type { UIMessage } from "ai";
import {
  CHATS_DIR,
  chatFileName,
  createAtomicStore,
  deleteStoreFiles,
  listStoreDir,
  readStoreFile,
  writeStoreFile,
  type StoreHandle,
} from "../lib/atomic-store";
import { prepareMessagesForPersist } from "../lib/persist-messages";
import { hydrateChatMessages, normalizeUIMessages } from "../lib/messages-utils";
import { createStoreRuntime } from "../lib/json-store";
import { reportWriteFailed, reportWriteSucceeded } from "../lib/store-health";

interface ChatSidecarRef {
  sidecar: string;
}

function isSidecarRef(value: unknown): value is ChatSidecarRef {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { sidecar?: unknown }).sidecar === "string" &&
    (value as ChatSidecarRef).sidecar.length >= 8
  );
}

async function resolveStoredPayload(raw: unknown): Promise<unknown> {
  if (!isSidecarRef(raw)) return raw;
  const text = await readStoreFile(chatFileName(raw.sidecar));
  if (typeof text !== "string") return [];
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

const STORE_PATH = "pagewise-v3-chats.json";
/**
 * Fingerprint → path, kept beside the chats. A chat is keyed by path because
 * everything in the app addresses a document by path; this index is what lets
 * a renamed file find the chat it had. See `file-identity.ts`.
 */
const IDENTITY_INDEX_KEY = "pagewise:identity-index";

/**
 * Path → when its chat was last saved (16.0). The store's `keys()` has no
 * order — the plugin keeps a hash map — so pruning "the oldest" needs its own
 * record of age (B8).
 */
const SAVED_AT_KEY = "pagewise:saved-at";
const RESERVED_KEYS = new Set([IDENTITY_INDEX_KEY, SAVED_AT_KEY]);

async function readSavedAt(store: StoreHandle): Promise<Record<string, number>> {
  const raw = await store.get<unknown>(SAVED_AT_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function chatKey(path: string): string {
  return path;
}

async function readIdentityIndex(store: StoreHandle): Promise<Record<string, string>> {
  const raw = await store.get<unknown>(IDENTITY_INDEX_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

/**
 * Serializes every mutation so a 500ms autosave, a document-switch save, a
 * close-flush, and a clear can't interleave their set/delete + save cycles and
 * resurrect a just-cleared chat via last-write-wins.
 */
const runtime = createStoreRuntime(() => createAtomicStore(STORE_PATH));

/**
 * The chat for a document — by path, then by fingerprint.
 *
 * A chat found under another path for a file with this content is moved to
 * the path the file has now, so a renamed document opens with its own
 * conversation rather than an empty one.
 */
export async function loadChat(path: string, identity?: string): Promise<UIMessage[]> {
  try {
    const store = await runtime.store();
    let raw = await store.get<unknown>(chatKey(path));
    if ((raw === null || raw === undefined) && identity) {
      const index = await readIdentityIndex(store);
      const oldPath = index[identity];
      if (oldPath && oldPath !== path) {
        const moved = await store.get<unknown>(chatKey(oldPath));
        if (moved !== null && moved !== undefined) {
          raw = moved;
          await runtime.withStoreLock(async () => {
            await store.set(chatKey(path), moved);
            await store.delete(chatKey(oldPath));
            await store.set(IDENTITY_INDEX_KEY, { ...index, [identity]: path });
            await store.save();
          });
        }
      }
    }
    const messages = normalizeUIMessages(await resolveStoredPayload(raw));
    if (messages.length === 0) return [];
    return hydrateChatMessages(messages);
  } catch {
    return [];
  }
}

export async function saveChat(
  path: string,
  messages: UIMessage[],
  identity?: string,
): Promise<void> {
  try {
    await writeChat(path, messages, identity);
  } catch (err) {
    reportWriteFailed(STORE_PATH, "conversation");
    throw err;
  }
  reportWriteSucceeded(STORE_PATH);
}

function writeChat(path: string, messages: UIMessage[], identity?: string): Promise<void> {
  return runtime.withStoreLock(async () => {
    const store = await runtime.store();
    const existing = await store.get<unknown>(chatKey(path));
    const sidecar = isSidecarRef(existing) ? existing.sidecar : crypto.randomUUID();
    const prepared = prepareMessagesForPersist(messages);
    await writeStoreFile(chatFileName(sidecar), JSON.stringify(prepared));
    await store.set(chatKey(path), { sidecar });
    await store.set(SAVED_AT_KEY, { ...(await readSavedAt(store)), [chatKey(path)]: Date.now() });
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
  try {
    await removeChat(path);
  } catch (err) {
    reportWriteFailed(STORE_PATH, "conversation");
    throw err;
  }
  reportWriteSucceeded(STORE_PATH);
}

function removeChat(path: string): Promise<void> {
  return runtime.withStoreLock(async () => {
    const store = await runtime.store();
    const existing = await store.get<unknown>(chatKey(path));
    await store.delete(chatKey(path));
    const savedAt = await readSavedAt(store);
    delete savedAt[chatKey(path)];
    await store.set(SAVED_AT_KEY, savedAt);
    await store.save();
    if (isSidecarRef(existing)) {
      await deleteStoreFiles([chatFileName(existing.sidecar)]).catch(() => {});
    }
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
    await runtime.withStoreLock(async () => {
      const store = await runtime.store();
      const keys = (await store.keys()).filter((k) => !RESERVED_KEYS.has(k));
      if (keys.length > maxChats) {
        const keep = new Set(keepPaths.map(chatKey));
        // Oldest save first; a chat saved before 16.0 recorded ages counts as
        // oldest of all. Drop those outside the recents until under the cap.
        const savedAt = await readSavedAt(store);
        const recorded = Object.keys(savedAt).length > 0;
        const droppable = keys
          .filter((k) => !keep.has(k))
          .sort((a, b) => (savedAt[a] ?? 0) - (savedAt[b] ?? 0));
        const dropCount = Math.min(droppable.length, keys.length - maxChats);
        if (dropCount > 0) {
          const droppedSidecars: string[] = [];
          for (const k of droppable.slice(0, dropCount)) {
            const val = await store.get<unknown>(k);
            if (isSidecarRef(val)) droppedSidecars.push(chatFileName(val.sidecar));
            await store.delete(k);
            delete savedAt[k];
          }
          if (recorded) await store.set(SAVED_AT_KEY, savedAt);
          await store.save();
          if (droppedSidecars.length > 0) {
            await deleteStoreFiles(droppedSidecars).catch(() => {});
          }
        }
      }
      // Sweep any unreferenced sidecar files left behind by interrupted writes.
      const liveKeys = (await store.keys()).filter((k) => !RESERVED_KEYS.has(k));
      const referenced = new Set<string>();
      for (const k of liveKeys) {
        const val = await store.get<unknown>(k);
        if (isSidecarRef(val)) referenced.add(chatFileName(val.sidecar));
      }
      const present = await listStoreDir(CHATS_DIR);
      const orphans = present.filter((name) => !referenced.has(name));
      if (orphans.length > 0) {
        await deleteStoreFiles(orphans).catch(() => {});
      }
    });
  } catch {
    /* best-effort cleanup */
  }
}
