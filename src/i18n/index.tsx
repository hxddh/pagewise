import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  loadPreferences,
  savePreferences,
  type AppPreferences,
  type LocaleMode,
} from "../lib/preferences";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export type Locale = "en" | "zh-CN";

const catalogs: Record<Locale, typeof en> = { en, "zh-CN": zhCN };

export function resolveLocale(mode: LocaleMode): Locale {
  if (mode === "system") {
    const lang = navigator.language.toLowerCase();
    if (lang.startsWith("zh")) return "zh-CN";
    return "en";
  }
  return mode;
}

function getPath(obj: Record<string, unknown>, path: string): string {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object" || !(part in cur)) return path;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "string" ? cur : path;
}

function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    vars[key] !== undefined ? String(vars[key]) : `{{${key}}}`,
  );
}

interface I18nContextValue {
  locale: Locale;
  localeMode: LocaleMode;
  setLocaleMode: (mode: LocaleMode) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  refreshFromPreferences: () => Promise<void>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<AppPreferences | null>(null);

  const localeMode = prefs?.locale ?? "system";
  const locale = resolveLocale(localeMode);
  const messages = catalogs[locale];

  const refreshFromPreferences = useCallback(async () => {
    setPrefs(await loadPreferences());
  }, []);

  useEffect(() => {
    void refreshFromPreferences();
  }, [refreshFromPreferences]);

  useEffect(() => {
    document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";
  }, [locale]);

  const setLocaleMode = useCallback(
    async (mode: LocaleMode) => {
      const current = await loadPreferences();
      const next = { ...current, locale: mode };
      await savePreferences(next);
      setPrefs(next);
    },
    [],
  );

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const raw = getPath(messages as Record<string, unknown>, key);
      if (vars?.count !== undefined) {
        const pluralKey = vars.count === 1 ? key : `${key}_plural`;
        const pluralRaw = getPath(messages as Record<string, unknown>, pluralKey);
        if (pluralRaw !== pluralKey) {
          return interpolate(pluralRaw, vars);
        }
      }
      return interpolate(raw, vars);
    },
    [messages],
  );

  const value = useMemo(
    () => ({ locale, localeMode, setLocaleMode, t, refreshFromPreferences }),
    [locale, localeMode, setLocaleMode, t, refreshFromPreferences],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
