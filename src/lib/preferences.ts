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
  /**
   * Pages the automatic vision sweep may index per document (0 = off). Each one
   * is a billed vision call, so the default stays conservative; full coverage is
   * available on demand from the preview.
   */
  autoIndexPages: number;
  /**
   * Pages the assistant may scan while answering one question (0 = never).
   * Separate from `autoIndexPages`: that budget covers the background sweep,
   * which is the app scanning unprompted, while this one covers scanning the
   * assistant triggers by reading a page you asked about. Both are billed, so
   * both are capped — a single control would conflate "per document" with
   * "per question" and mean neither.
   */
  agentScanPages: number;
  /**
   * Read scanned pages on this computer (14.0). Free and private, and what
   * makes a scan's citations checkable; off only for a reader who would rather
   * spend the CPU on something else.
   */
  localOcr: boolean;
  /** Which models local OCR reads with. "auto" follows the interface language. */
  ocrLanguage: OcrLanguageMode;
}

export type OcrLanguageMode = "auto" | "eng" | "chi_sim+eng";

/**
 * The models local OCR should read with. "auto" follows the interface
 * language: Chinese reads with both models (slower, and needed for Chinese
 * print); anything else reads with English alone.
 */
export function resolveOcrLanguages(
  prefs: Pick<AppPreferences, "ocrLanguage" | "locale">,
  systemLanguage: string = typeof navigator === "undefined" ? "en" : navigator.language,
): "eng" | "chi_sim+eng" {
  // Always from the interface language since 16.0: the setting is gone, and a
  // choice stored before would otherwise stick with no way to change it.
  void prefs.ocrLanguage;
  const lang = prefs.locale === "system" ? systemLanguage.toLowerCase() : prefs.locale.toLowerCase();
  return lang.startsWith("zh") ? "chi_sim+eng" : "eng";
}
const OCR_LANGUAGE_MODES: OcrLanguageMode[] = ["auto", "eng", "chi_sim+eng"];

/** Selectable automatic-index budgets, smallest first. */
export const AUTO_INDEX_PAGE_CHOICES = [0, 20, 50, 200] as const;

/** Selectable per-question assistant scan allowances, smallest first. */
export const AGENT_SCAN_PAGE_CHOICES = [0, 10, 20, 50] as const;

const STORE_PATH = "preferences.json";
const KEY = "app";

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: "dark",
  locale: "system",
  lastSettingsTab: "general",
  followAgentDefault: true,
  includeViewingPageDefault: false,
  previewQuality: "crisp",
  autoIndexPages: 50,
  agentScanPages: 20,
  localOcr: true,
  ocrLanguage: "auto",
};

let store: LazyStore | null = null;

let prefsLock: Promise<unknown> = Promise.resolve();
function withPrefsLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = prefsLock.then(fn, fn);
  prefsLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

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

/**
 * Clamp a stored sweep budget into range. A corrupt or absurd value here would
 * otherwise translate directly into billed vision calls.
 */
function scanBudget(
  value: unknown,
  fallback: number,
  choices: readonly number[],
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < 0) return 0;
  const max = choices[choices.length - 1]!;
  return floored > max ? max : floored;
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
    autoIndexPages: scanBudget(
      saved.autoIndexPages,
      DEFAULT_PREFERENCES.autoIndexPages,
      AUTO_INDEX_PAGE_CHOICES,
    ),
    agentScanPages: scanBudget(
      saved.agentScanPages,
      DEFAULT_PREFERENCES.agentScanPages,
      AGENT_SCAN_PAGE_CHOICES,
    ),
    localOcr: bool(saved.localOcr, DEFAULT_PREFERENCES.localOcr),
    ocrLanguage: pick(saved.ocrLanguage, OCR_LANGUAGE_MODES, DEFAULT_PREFERENCES.ocrLanguage),
  };
}

export async function loadPreferences(): Promise<AppPreferences> {
  const s = await getStore();
  const saved = await s.get<unknown>(KEY);
  return sanitizePreferences(saved);
}

async function writePreferences(prefs: AppPreferences): Promise<void> {
  const s = await getStore();
  await s.set(KEY, prefs);
  await s.save();
}

export async function savePreferences(prefs: AppPreferences): Promise<void> {
  return withPrefsLock(() => writePreferences(prefs));
}

export async function patchPreferences(
  patch: Partial<AppPreferences>,
): Promise<AppPreferences> {
  return withPrefsLock(async () => {
    const current = await loadPreferences();
    const next = { ...current, ...patch };
    await writePreferences(next);
    return next;
  });
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
