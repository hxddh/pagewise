import { LazyStore } from "@tauri-apps/plugin-store";
import { DEFAULT_SETTINGS, type LlmSettings } from "./types";

const STORE_PATH = "settings.json";
const SETTINGS_KEY = "llm";

let store: LazyStore | null = null;

async function getStore(): Promise<LazyStore> {
  if (!store) {
    store = new LazyStore(STORE_PATH);
  }
  return store;
}

export async function loadSettings(): Promise<LlmSettings> {
  const s = await getStore();
  const saved = await s.get<LlmSettings>(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(settings: LlmSettings): Promise<void> {
  const s = await getStore();
  await s.set(SETTINGS_KEY, settings);
  await s.save();
}
