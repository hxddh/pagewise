import { LazyStore } from "@tauri-apps/plugin-store";
import type { PreviewQuality } from "./types";

export type ThemeMode = "dark" | "light" | "system";
export type LocaleMode = "en" | "zh-CN" | "system";
export type SettingsTab = "general" | "ai" | "shortcuts" | "about";
export type { PreviewQuality };

export interface AppPreferences {
  theme: ThemeMode;
  locale: LocaleMode;
  lastSettingsTab: SettingsTab;
  followAgentDefault: boolean;
  includeViewingPageDefault: boolean;
  previewQuality: PreviewQuality;
}

const STORE_PATH = "preferences.json";
const KEY = "app";

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: "dark",
  locale: "system",
  lastSettingsTab: "general",
  followAgentDefault: true,
  includeViewingPageDefault: true,
  previewQuality: "crisp",
};

let store: LazyStore | null = null;

async function getStore(): Promise<LazyStore> {
  if (!store) store = new LazyStore(STORE_PATH);
  return store;
}

export async function loadPreferences(): Promise<AppPreferences> {
  const s = await getStore();
  const saved = await s.get<Partial<AppPreferences>>(KEY);
  return { ...DEFAULT_PREFERENCES, ...saved };
}

export async function savePreferences(prefs: AppPreferences): Promise<void> {
  const s = await getStore();
  await s.set(KEY, prefs);
  await s.save();
}

export async function patchPreferences(
  patch: Partial<AppPreferences>,
): Promise<AppPreferences> {
  const current = await loadPreferences();
  const next = { ...current, ...patch };
  await savePreferences(next);
  return next;
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
