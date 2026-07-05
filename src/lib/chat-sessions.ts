import { LazyStore } from "@tauri-apps/plugin-store";
import type { UIMessage } from "ai";
import { normalizeUIMessages } from "./messages-utils";

const STORE_PATH = "sessions.json";
const STORE_KEY = "data";
const DEFAULT_THREAD_ID = "default";

export interface ChatThread {
  id: string;
  name: string;
  messages: UIMessage[];
  updatedAt: number;
}

export interface DocSessions {
  docName: string;
  activeSessionId: string;
  threads: ChatThread[];
}

export interface StoredChatSession {
  docPath: string;
  docName: string;
  sessionId: string;
  sessionName: string;
  messages: UIMessage[];
  updatedAt: number;
}

interface SessionStoreV2 {
  version: 2;
  byPath: Record<string, DocSessions>;
}

interface LegacyEntry {
  docName: string;
  messages: UIMessage[];
  updatedAt: number;
}

let store: LazyStore | null = null;

/** In-memory store for unit tests. */
let memoryStore: SessionStoreV2 | null = null;

export function __resetSessionStoreForTests(data: SessionStoreV2 | null = null): void {
  memoryStore = data;
  store = null;
}

async function getStore(): Promise<LazyStore> {
  if (memoryStore !== null) {
    return {
      get: async (key: string) => (key === STORE_KEY ? memoryStore : null),
      set: async (key: string, value: unknown) => {
        if (key === STORE_KEY) memoryStore = value as SessionStoreV2;
      },
      save: async () => {},
    } as unknown as LazyStore;
  }
  if (!store) store = new LazyStore(STORE_PATH);
  return store;
}

function defaultThreadName(index: number): string {
  return index === 0 ? "Default" : `Chat ${index + 1}`;
}

/**
 * Serializes every store mutation through a single promise chain so concurrent
 * read-modify-write cycles (e.g. a debounced save racing a user action) can't
 * interleave and drop messages via last-write-wins.
 */
let storeLock: Promise<unknown> = Promise.resolve();
function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = storeLock.then(fn, fn);
  storeLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Coerce one raw doc entry into a valid DocSessions, or null if unusable. */
function sanitizeDoc(raw: unknown): DocSessions | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (!Array.isArray(d.threads)) return null;

  const threads: ChatThread[] = [];
  for (const t of d.threads) {
    if (!t || typeof t !== "object") continue;
    const tt = t as Record<string, unknown>;
    if (typeof tt.id !== "string") continue;
    threads.push({
      id: tt.id,
      name: typeof tt.name === "string" ? tt.name : "Default",
      messages: normalizeUIMessages(tt.messages),
      updatedAt: typeof tt.updatedAt === "number" ? tt.updatedAt : Date.now(),
    });
  }

  const activeSessionId =
    typeof d.activeSessionId === "string"
      ? d.activeSessionId
      : (threads[0]?.id ?? DEFAULT_THREAD_ID);
  const docName = typeof d.docName === "string" ? d.docName : "";
  return { docName, activeSessionId, threads };
}

function migrate(raw: unknown): SessionStoreV2 {
  if (raw && typeof raw === "object" && "version" in raw && (raw as SessionStoreV2).version === 2) {
    const byPathRaw = (raw as { byPath?: unknown }).byPath;
    // A version-2 marker with a missing/invalid byPath is corrupt — never trust it,
    // or every consumer throws TypeError forever. Fall back to an empty store and
    // keep only structurally-valid doc entries.
    if (!byPathRaw || typeof byPathRaw !== "object" || Array.isArray(byPathRaw)) {
      return { version: 2, byPath: {} };
    }
    const byPath: Record<string, DocSessions> = {};
    for (const [docPath, entry] of Object.entries(byPathRaw as Record<string, unknown>)) {
      const doc = sanitizeDoc(entry);
      if (doc) byPath[docPath] = doc;
    }
    return { version: 2, byPath };
  }

  const legacy = raw as { byPath?: Record<string, LegacyEntry> } | null;
  const byPath: Record<string, DocSessions> = {};

  if (legacy?.byPath && typeof legacy.byPath === "object" && !Array.isArray(legacy.byPath)) {
    for (const [docPath, entry] of Object.entries(legacy.byPath)) {
      if (!entry || typeof entry !== "object") continue;
      byPath[docPath] = {
        docName: typeof entry.docName === "string" ? entry.docName : "",
        activeSessionId: DEFAULT_THREAD_ID,
        threads: [
          {
            id: DEFAULT_THREAD_ID,
            name: "Default",
            messages: normalizeUIMessages(entry.messages),
            updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
          },
        ],
      };
    }
  }

  return { version: 2, byPath };
}

async function readStore(): Promise<SessionStoreV2> {
  const s = await getStore();
  const raw = await s.get(STORE_KEY);
  if (!raw) {
    const legacy = await s.get<{ byPath?: Record<string, LegacyEntry> }>("byPath");
    return migrate(legacy ? { byPath: legacy.byPath } : null);
  }
  return migrate(raw);
}

async function writeStore(data: SessionStoreV2): Promise<void> {
  const s = await getStore();
  await s.set(STORE_KEY, data);
  await s.save();
}

function getDoc(data: SessionStoreV2, docPath: string): DocSessions | undefined {
  return data.byPath[docPath];
}

export async function loadActiveMessages(
  docPath: string,
  preferredSessionId?: string,
  options?: { readOnly?: boolean },
): Promise<{
  messages: UIMessage[];
  sessionId: string;
  threads: ChatThread[];
  docName: string;
}> {
  return withStoreLock(async () => {
    const data = await readStore();
    const doc = getDoc(data, docPath);
    if (!doc) {
      return { messages: [], sessionId: DEFAULT_THREAD_ID, threads: [], docName: "" };
    }

    const sessionId = preferredSessionId ?? doc.activeSessionId;
    const thread =
      doc.threads.find((t) => t.id === sessionId) ??
      doc.threads.find((t) => t.id === doc.activeSessionId) ??
      doc.threads[0];

    // Only persist the preferred session as active when it actually resolved to a
    // real thread — otherwise we'd point activeSessionId at a non-existent thread.
    if (
      !options?.readOnly &&
      preferredSessionId &&
      thread?.id === preferredSessionId &&
      doc.activeSessionId !== preferredSessionId
    ) {
      doc.activeSessionId = preferredSessionId;
      await writeStore(data);
    }

    return {
      messages: thread?.messages ?? [],
      sessionId: thread?.id ?? DEFAULT_THREAD_ID,
      threads: doc.threads,
      docName: doc.docName,
    };
  });
}

/**
 * Persist messages for a document thread. Empty messages are a no-op — they never
 * delete stored history (use clearActiveThread for explicit clears).
 */
export async function saveActiveSession(
  docPath: string,
  docName: string,
  sessionId: string,
  messages: UIMessage[],
): Promise<void> {
  if (messages.length === 0) return;

  return withStoreLock(async () => {
    const data = await readStore();
    let doc = getDoc(data, docPath);

    if (!doc) {
      // A missing doc with a non-default sessionId means the thread was created via
      // createThread and then deleted (its doc entry was removed). A late debounced
      // save must not resurrect it under a wrong "Default" name — skip it.
      if (sessionId !== DEFAULT_THREAD_ID) return;

      doc = {
        docName,
        activeSessionId: sessionId,
        threads: [
          {
            id: sessionId,
            name: defaultThreadName(0),
            messages,
            updatedAt: Date.now(),
          },
        ],
      };
      data.byPath[docPath] = doc;
      await writeStore(data);
      return;
    }

    doc.docName = docName;

    const idx = doc.threads.findIndex((t) => t.id === sessionId);
    const updated: ChatThread = {
      id: sessionId,
      name: idx >= 0 ? doc.threads[idx]!.name : defaultThreadName(doc.threads.length),
      messages,
      updatedAt: Date.now(),
    };

    if (idx >= 0) doc.threads[idx] = updated;
    else doc.threads.push(updated);

    // Saving a background thread must not steal the active-session pointer.
    if (doc.activeSessionId === sessionId || doc.threads.length === 1) {
      doc.activeSessionId = sessionId;
    }

    await writeStore(data);
  });
}

/** Explicitly remove a thread (user cleared chat). */
export async function clearActiveThread(docPath: string, sessionId: string): Promise<void> {
  return withStoreLock(async () => {
    const data = await readStore();
    const doc = getDoc(data, docPath);
    if (!doc) return;

    doc.threads = doc.threads.filter((t) => t.id !== sessionId);
    if (doc.threads.length === 0) {
      delete data.byPath[docPath];
    } else if (doc.activeSessionId === sessionId) {
      doc.activeSessionId = doc.threads[0]!.id;
    }
    await writeStore(data);
  });
}

function nextThreadName(threads: ChatThread[]): string {
  let max = 0;
  for (const t of threads) {
    const m = /^Chat (\d+)$/.exec(t.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Chat ${max + 1}`;
}

export async function createThread(
  docPath: string,
  docName: string,
): Promise<{ sessionId: string; threads: ChatThread[] }> {
  return withStoreLock(async () => {
    const data = await readStore();
    const id = crypto.randomUUID();

    let doc = getDoc(data, docPath);
    if (!doc) {
      doc = { docName, activeSessionId: id, threads: [] };
      data.byPath[docPath] = doc;
    }

    const name = nextThreadName(doc.threads);
    doc.threads.push({ id, name, messages: [], updatedAt: Date.now() });
    doc.activeSessionId = id;
    doc.docName = docName;
    await writeStore(data);

    return { sessionId: id, threads: doc.threads };
  });
}

export async function switchThread(
  docPath: string,
  sessionId: string,
): Promise<{ messages: UIMessage[]; sessionId: string }> {
  return withStoreLock(async () => {
    const data = await readStore();
    const doc = getDoc(data, docPath);
    if (!doc) return { messages: [], sessionId: DEFAULT_THREAD_ID };
    const thread = doc.threads.find((t) => t.id === sessionId);
    if (!thread) {
      const activeId = doc.activeSessionId;
      const active = doc.threads.find((t) => t.id === activeId);
      return { messages: active?.messages ?? [], sessionId: activeId };
    }
    doc.activeSessionId = sessionId;
    await writeStore(data);
    return { messages: thread.messages, sessionId };
  });
}

export async function deleteThread(docPath: string, sessionId: string): Promise<void> {
  await clearActiveThread(docPath, sessionId);
}

export async function clearDocSessions(docPath: string): Promise<void> {
  return withStoreLock(async () => {
    const data = await readStore();
    delete data.byPath[docPath];
    await writeStore(data);
  });
}

export async function listChatSessions(): Promise<StoredChatSession[]> {
  return withStoreLock(async () => {
    const data = await readStore();
    const out: StoredChatSession[] = [];

    for (const [docPath, doc] of Object.entries(data.byPath)) {
      for (const thread of doc.threads) {
        if (thread.messages.length === 0) continue;
        out.push({
          docPath,
          docName: doc.docName,
          sessionId: thread.id,
          sessionName: thread.name,
          messages: thread.messages,
          updatedAt: thread.updatedAt,
        });
      }
    }

    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

export async function clearChatSession(docPath: string): Promise<void> {
  await clearDocSessions(docPath);
}
