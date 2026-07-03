import { useCallback, useEffect, useState } from "react";
import {
  applyTheme,
  loadPreferences,
  resolveTheme,
  savePreferences,
  type AppPreferences,
  type ThemeMode,
} from "../lib/preferences";

export function useTheme() {
  const [preferences, setPreferences] = useState<AppPreferences | null>(null);
  const resolved = preferences ? resolveTheme(preferences.theme) : "dark";

  useEffect(() => {
    loadPreferences().then(setPreferences);
  }, []);

  useEffect(() => {
    if (!preferences) return;
    applyTheme(resolved);

    if (preferences.theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(resolveTheme("system"));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [preferences, resolved]);

  const setTheme = useCallback(async (theme: ThemeMode) => {
    const next = { theme };
    setPreferences(next);
    await savePreferences(next);
    applyTheme(resolveTheme(theme));
  }, []);

  const cycleTheme = useCallback(async () => {
    const order: ThemeMode[] = ["dark", "light", "system"];
    const current = preferences?.theme ?? "dark";
    const next = order[(order.indexOf(current) + 1) % order.length];
    await setTheme(next);
  }, [preferences?.theme, setTheme]);

  const reloadPreferences = useCallback(async () => {
    const prefs = await loadPreferences();
    setPreferences(prefs);
    return prefs;
  }, []);

  return { theme: preferences?.theme ?? "dark", resolved, setTheme, cycleTheme, reloadPreferences };
}
