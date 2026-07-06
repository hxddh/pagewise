import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  patchPreferences,
  type AppPreferences,
} from "../lib/preferences";

export function useWorkbenchPrefs() {
  const [prefs, setPrefs] = useState<AppPreferences>(DEFAULT_PREFERENCES);
  const [prefsRevision, setPrefsRevision] = useState(0);
  const [followAgent, setFollowAgent] = useState(DEFAULT_PREFERENCES.followAgentDefault);
  const [includeViewingPage, setIncludeViewingPage] = useState(
    DEFAULT_PREFERENCES.includeViewingPageDefault,
  );

  useEffect(() => {
    void loadPreferences().then((p) => {
      setPrefs(p);
      setFollowAgent(p.followAgentDefault);
      setIncludeViewingPage(p.includeViewingPageDefault);
    });
  }, []);

  const refreshPrefs = useCallback(async () => {
    const p = await loadPreferences();
    setPrefs(p);
    setFollowAgent(p.followAgentDefault);
    setIncludeViewingPage(p.includeViewingPageDefault);
    setPrefsRevision((r) => r + 1);
    return p;
  }, []);

  const toggleFollowAgent = useCallback(async () => {
    const next = !followAgent;
    setFollowAgent(next);
    const p = await patchPreferences({ followAgentDefault: next });
    setPrefs(p);
  }, [followAgent]);

  const setIncludeViewingPageDefault = useCallback(async (value: boolean) => {
    setIncludeViewingPage(value);
    const p = await patchPreferences({ includeViewingPageDefault: value });
    setPrefs(p);
  }, []);

  const setFollowAgentDefault = useCallback(async (value: boolean) => {
    setFollowAgent(value);
    const p = await patchPreferences({ followAgentDefault: value });
    setPrefs(p);
  }, []);

  return {
    prefs,
    prefsRevision,
    followAgent,
    includeViewingPage,
    toggleFollowAgent,
    setFollowAgentDefault,
    setIncludeViewingPageDefault,
    refreshPrefs,
  };
}
