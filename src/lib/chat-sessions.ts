import { LazyStore } from "@tauri-apps/plugin-store";
import type { UIMessage } from "ai";

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

function migrate(raw: unknown): SessionStoreV2 {
  if (raw && typeof raw === "object" && "version" in raw && (raw as SessionStoreV2).version === 2) {
    return raw as SessionStoreV2;
  }

  const legacy = raw as { byPath?: Record<string, LegacyEntry> } | null;
  const byPath: Record<string, DocSessions> = {};

  if (legacy?.byPath) {
    for (const [docPath, entry] of Object.entries(legacy.byPath)) {
      byPath[docPath] = {
        docName: entry.docName,
        activeSessionId: DEFAULT_THREAD_ID,
        threads: [
          {
            id: DEFAULT_THREAD_ID,
            name: "Default",
            messages: entry.messages ?? [],
            updatedAt: entry.updatedAt ?? Date.now(),
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
): Promise<{
  messages: UIMessage[];
  sessionId: string;
  threads: ChatThread[];
  docName: string;
}> {
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

  if (preferredSessionId && preferredSessionId !== doc.activeSessionId) {
    doc.activeSessionId = preferredSessionId;
    await writeStore(data);
  }

  return {
    messages: thread?.messages ?? [],
    sessionId: thread?.id ?? DEFAULT_THREAD_ID,
    threads: doc.threads,
    docName: doc.docName,
  };
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

  const data = await readStore();
  let doc = getDoc(data, docPath);

  if (!doc) {
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
  doc.activeSessionId = sessionId;

  const idx = doc.threads.findIndex((t) => t.id === sessionId);
  const updated: ChatThread = {
    id: sessionId,
    name: idx >= 0 ? doc.threads[idx].name : defaultThreadName(doc.threads.length),
    messages,
    updatedAt: Date.now(),
  };

  if (idx >= 0) doc.threads[idx] = updated;
  else doc.threads.push(updated);

  await writeStore(data);
}

/** Explicitly remove a thread (user cleared chat). */
export async function clearActiveThread(docPath: string, sessionId: string): Promise<void> {
  const data = await readStore();
  const doc = getDoc(data, docPath);
  if (!doc) return;

  doc.threads = doc.threads.filter((t) => t.id !== sessionId);
  if (doc.threads.length === 0) {
    delete data.byPath[docPath];
  } else if (doc.activeSessionId === sessionId) {
    doc.activeSessionId = doc.threads[0].id;
  }
  await writeStore(data);
}

export async function createThread(
  docPath: string,
  docName: string,
): Promise<{ sessionId: string; threads: ChatThread[] }> {
  const data = await readStore();
  const id = crypto.randomUUID();
  const name = `Chat ${(getDoc(data, docPath)?.threads.length ?? 0) + 1}`;

  let doc = getDoc(data, docPath);
  if (!doc) {
    doc = { docName, activeSessionId: id, threads: [] };
    data.byPath[docPath] = doc;
  }

  doc.threads.push({ id, name, messages: [], updatedAt: Date.now() });
  doc.activeSessionId = id;
  doc.docName = docName;
  await writeStore(data);

  return { sessionId: id, threads: doc.threads };
}

export async function switchThread(docPath: string, sessionId: string): Promise<UIMessage[]> {
  const data = await readStore();
  const doc = getDoc(data, docPath);
  if (!doc) return [];
  doc.activeSessionId = sessionId;
  await writeStore(data);
  return doc.threads.find((t) => t.id === sessionId)?.messages ?? [];
}

export async function deleteThread(docPath: string, sessionId: string): Promise<void> {
  await clearActiveThread(docPath, sessionId);
}

export async function clearDocSessions(docPath: string): Promise<void> {
  const data = await readStore();
  delete data.byPath[docPath];
  await writeStore(data);
}

export async function listChatSessions(): Promise<StoredChatSession[]> {
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
}

export async function clearChatSession(docPath: string): Promise<void> {
  await clearDocSessions(docPath);
}
