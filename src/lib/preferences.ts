import { LazyStore } from "@tauri-apps/plugin-store";

export type ThemeMode = "dark" | "light" | "system";

export interface AppPreferences {
  theme: ThemeMode;
}

const STORE_PATH = "preferences.json";
const KEY = "app";

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: "dark",
};

let store: LazyStore | null = null;

async function getStore(): Promise<LazyStore> {
  if (!store) store = new LazyStore(STORE_PATH);
  return store;
}

export async function loadPreferences(): Promise<AppPreferences> {
  const s = await getStore();
  const saved = await s.get<AppPreferences>(KEY);
  return { ...DEFAULT_PREFERENCES, ...saved };
}

export async function savePreferences(prefs: AppPreferences): Promise<void> {
  const s = await getStore();
  await s.set(KEY, prefs);
  await s.save();
}

export function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

export function applyTheme(resolved: "dark" | "light"): void {
  document.documentElement.setAttribute("data-theme", resolved);
}
