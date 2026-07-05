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
  includeViewingPageDefault: false,
  previewQuality: "crisp",
};

let store: LazyStore | null = null;

async function getStore(): Promise<LazyStore> {
  if (!store) store = new LazyStore(STORE_PATH);
  return store;
}

const THEME_MODES: ThemeMode[] = ["dark", "light", "system"];
const LOCALE_MODES: LocaleMode[] = ["en", "zh-CN", "system"];
const SETTINGS_TABS: SettingsTab[] = ["general", "ai", "shortcuts", "about"];
const PREVIEW_QUALITIES: PreviewQuality[] = ["auto", "crisp", "performance"];

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Coerce arbitrary stored data into a valid AppPreferences, ignoring corrupt fields. */
export function sanitizePreferences(raw: unknown): AppPreferences {
  const saved = (raw && typeof raw === "object" ? raw : {}) as Partial<AppPreferences>;
  return {
    theme: pick(saved.theme, THEME_MODES, DEFAULT_PREFERENCES.theme),
    locale: pick(saved.locale, LOCALE_MODES, DEFAULT_PREFERENCES.locale),
    lastSettingsTab: pick(saved.lastSettingsTab, SETTINGS_TABS, DEFAULT_PREFERENCES.lastSettingsTab),
    followAgentDefault: bool(saved.followAgentDefault, DEFAULT_PREFERENCES.followAgentDefault),
    includeViewingPageDefault: bool(
      saved.includeViewingPageDefault,
      DEFAULT_PREFERENCES.includeViewingPageDefault,
    ),
    previewQuality: pick(saved.previewQuality, PREVIEW_QUALITIES, DEFAULT_PREFERENCES.previewQuality),
  };
}

export async function loadPreferences(): Promise<AppPreferences> {
  const s = await getStore();
  const saved = await s.get<unknown>(KEY);
  return sanitizePreferences(saved);
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
