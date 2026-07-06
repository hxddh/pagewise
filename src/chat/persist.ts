import type { UIMessage } from "ai";
import { Store } from "@tauri-apps/plugin-store";
import { prepareMessagesForPersist } from "../lib/persist-messages";
import { hydrateChatMessages } from "../lib/messages-utils";

const STORE_PATH = "pagewise-v3-chats.json";

function chatKey(path: string): string {
  return path;
}

let storePromise: Promise<Store> | null = null;

async function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load(STORE_PATH);
  }
  return storePromise;
}

export async function loadChat(path: string): Promise<UIMessage[]> {
  const store = await getStore();
  const raw = await store.get<UIMessage[]>(chatKey(path));
  if (!raw?.length) return [];
  return hydrateChatMessages(raw);
}

export async function saveChat(path: string, messages: UIMessage[]): Promise<void> {
  const store = await getStore();
  await store.set(chatKey(path), prepareMessagesForPersist(messages));
  await store.save();
}

export async function clearChat(path: string): Promise<void> {
  const store = await getStore();
  await store.delete(chatKey(path));
  await store.save();
}
