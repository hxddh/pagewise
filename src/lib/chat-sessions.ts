import { LazyStore } from "@tauri-apps/plugin-store";
import type { UIMessage } from "ai";

const STORE_PATH = "sessions.json";
const KEY = "byPath";

export interface StoredChatSession {
  docPath: string;
  docName: string;
  messages: UIMessage[];
  updatedAt: number;
}

interface SessionStore {
  byPath: Record<string, Omit<StoredChatSession, "docPath">>;
}

let store: LazyStore | null = null;

async function getStore(): Promise<LazyStore> {
  if (!store) store = new LazyStore(STORE_PATH);
  return store;
}

export async function loadChatSession(docPath: string): Promise<UIMessage[]> {
  const s = await getStore();
  const data = await s.get<SessionStore>(KEY);
  return data?.byPath?.[docPath]?.messages ?? [];
}

export async function saveChatSession(
  docPath: string,
  docName: string,
  messages: UIMessage[],
): Promise<void> {
  if (messages.length === 0) {
    await clearChatSession(docPath);
    return;
  }

  const s = await getStore();
  const data = (await s.get<SessionStore>(KEY)) ?? { byPath: {} };
  data.byPath[docPath] = {
    docName,
    messages,
    updatedAt: Date.now(),
  };
  await s.set(KEY, data);
  await s.save();
}

export async function clearChatSession(docPath: string): Promise<void> {
  const s = await getStore();
  const data = await s.get<SessionStore>(KEY);
  if (!data?.byPath?.[docPath]) return;
  delete data.byPath[docPath];
  await s.set(KEY, data);
  await s.save();
}

export async function listChatSessions(): Promise<StoredChatSession[]> {
  const s = await getStore();
  const data = await s.get<SessionStore>(KEY);
  if (!data?.byPath) return [];

  return Object.entries(data.byPath)
    .map(([docPath, session]) => ({ docPath, ...session }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
