import { LazyStore } from "@tauri-apps/plugin-store";
import type { PreviewQuality } from "./types";
import { createStoreRuntime } from "./json-store";

/**
 * `paper` is the third reading surface, not a variant of light: a warm white
 * page under a warm grey chrome. It exists because a reader who spends an hour
 * in a document wants the page to look like paper, and both of the other two
 * themes are built around the app's own greys.
 */
export type ThemeMode = "dark" | "light" | "paper" | "system";
export type ResolvedTheme = "dark" | "light" | "paper";
export type LocaleMode = "en" | "zh-CN" | "system";
/** 18.0: the AI provider tab is gone — one settings surface, three groups. */
export type SettingsTab = "general" | "shortcuts" | "about";
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
  /**
   * The line under every settled answer: pages, steps, tokens in/out, cache
   * hits, scan calls. On by default — a reader who is paying per question is
   * entitled to see what it cost, and off is for the reader who finds it noise.
   */
  showUsageLine: boolean;
  /** The answer column's text scale (three steps). See `READING_SCALE_CHOICES`. */
  readingScale: number;
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

/**
 * Selectable automatic-index budgets, smallest first (19.0: three, not four).
 *
 * The row is Off / Auto / All: don't read scans, read them in the background,
 * or read the whole document now (which is the old scan-all command, with its
 * confirmation). Two of the old four steps — 50 and 200 — both meant "a lot",
 * and the reader could not tell them apart; the one that remains means the
 * whole document and is wired to the action that says so.
 */
export const AUTO_INDEX_PAGE_CHOICES = [0, 20, 200] as const;

/** Selectable per-question assistant scan allowances, smallest first. */
export const AGENT_SCAN_PAGE_CHOICES = [0, 10, 50] as const;

/** The answer column's text scale: small, default, large. */
export const READING_SCALE_CHOICES = [0.95, 1, 1.1] as const;

const STORE_PATH = "preferences.json";
const KEY = "app";

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: "dark",
  locale: "system",
  lastSettingsTab: "general",
  followAgentDefault: true,
  includeViewingPageDefault: false,
  previewQuality: "crisp",
  // 18.0 lowered both scan budgets: the background sweep was 50 pages of billed
  // vision calls on every document opened, and a question could spend 20 more.
  // Full coverage is still one command away, and the reader now sees the count.
  autoIndexPages: 20,
  agentScanPages: 10,
  localOcr: true,
  ocrLanguage: "auto",
  showUsageLine: true,
  readingScale: 1,
};

const runtime = createStoreRuntime(() => new LazyStore(STORE_PATH));

const THEME_MODES: ThemeMode[] = ["dark", "light", "paper", "system"];
const LOCALE_MODES: LocaleMode[] = ["en", "zh-CN", "system"];
const SETTINGS_TABS: SettingsTab[] = ["general", "shortcuts", "about"];
const PREVIEW_QUALITIES: PreviewQuality[] = ["auto", "crisp", "performance"];

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Clamp a stored sweep budget to one of the allowed choices.
 *
 * A corrupt or absurd value here would otherwise translate directly into
 * billed vision calls. Snapped to the nearest choice at or below the stored
 * value rather than clamped to the largest: 19.0 removed the 50-page step, and
 * a reader who had it should land on the step below (Auto), not silently on
 * the whole-document budget.
 */
function scanBudget(
  value: unknown,
  fallback: number,
  choices: readonly number[],
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  let best = choices[0]!;
  for (const choice of choices) {
    if (choice <= floored) best = choice;
  }
  return best;
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
    showUsageLine: bool(saved.showUsageLine, DEFAULT_PREFERENCES.showUsageLine),
    readingScale: pick(saved.readingScale, READING_SCALE_CHOICES, DEFAULT_PREFERENCES.readingScale),
  };
}

export async function loadPreferences(): Promise<AppPreferences> {
  const s = await runtime.store();
  const saved = await s.get<unknown>(KEY);
  return sanitizePreferences(saved);
}

async function writePreferences(prefs: AppPreferences): Promise<void> {
  const s = await runtime.store();
  await s.set(KEY, prefs);
  await s.save();
}

export async function patchPreferences(
  patch: Partial<AppPreferences>,
): Promise<AppPreferences> {
  return runtime.withStoreLock(async () => {
    const current = await loadPreferences();
    const next = { ...current, ...patch };
    await writePreferences(next);
    return next;
  });
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.setAttribute("data-theme", resolved);
}

/**
 * The answer column's text scale, as one CSS variable.
 *
 * Scaling only the reading sizes (not the whole panel) is deliberate: the
 * chrome around an answer is already at its floor, and a reader asking for
 * larger text means the prose, not the buttons.
 */
export function applyReadingScale(scale: number): void {
  document.documentElement.style.setProperty("--reading-scale", String(scale));
}
