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
  applyTheme,
  loadPreferences,
  patchPreferences,
  resolveTheme,
  type AppPreferences,
  type ThemeMode,
} from "../lib/preferences";

interface ThemeContextValue {
  theme: ThemeMode;
  resolved: "dark" | "light";
  setTheme: (theme: ThemeMode) => Promise<void>;
  cycleTheme: () => Promise<void>;
  reloadPreferences: () => Promise<AppPreferences>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<AppPreferences | null>(null);
  const [resolved, setResolved] = useState<"dark" | "light">("dark");

  useEffect(() => {
    loadPreferences().then(setPreferences);
  }, []);

  useEffect(() => {
    if (!preferences) return;
    // Keep `resolved` in React state (not just the DOM) so an OS theme change in
    // "system" mode re-renders consumers of useTheme().resolved, not only the
    // <html> attribute.
    const apply = () => {
      const next = resolveTheme(preferences.theme);
      setResolved(next);
      applyTheme(next);
    };
    apply();

    if (preferences.theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [preferences]);

  const setTheme = useCallback(async (theme: ThemeMode) => {
    const next = await patchPreferences({ theme });
    setPreferences(next);
    applyTheme(resolveTheme(theme));
  }, []);

  const cycleTheme = useCallback(async () => {
    const order: ThemeMode[] = ["dark", "light", "system"];
    const current = preferences?.theme ?? "dark";
    const nextTheme = order[(order.indexOf(current) + 1) % order.length]!;
    await setTheme(nextTheme);
  }, [preferences?.theme, setTheme]);

  const reloadPreferences = useCallback(async () => {
    const prefs = await loadPreferences();
    setPreferences(prefs);
    return prefs;
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: preferences?.theme ?? "dark",
      resolved,
      setTheme,
      cycleTheme,
      reloadPreferences,
    }),
    [preferences?.theme, resolved, setTheme, cycleTheme, reloadPreferences],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
