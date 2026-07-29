import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  patchPreferences,
  type AppPreferences,
} from "../lib/preferences";
import { setAutoIndexCap } from "../document/index-queue";

export function useWorkbenchPrefs() {
  const [prefs, setPrefs] = useState<AppPreferences>(DEFAULT_PREFERENCES);
  const [prefsRevision, setPrefsRevision] = useState(0);
  const [followAgent, setFollowAgent] = useState(DEFAULT_PREFERENCES.followAgentDefault);
  const [includeViewingPage, setIncludeViewingPage] = useState(
    DEFAULT_PREFERENCES.includeViewingPageDefault,
  );

  useEffect(() => {
    void loadPreferences()
      .then((p) => {
        setPrefs(p);
        setFollowAgent(p.followAgentDefault);
        setIncludeViewingPage(p.includeViewingPageDefault);
        // The sweep budget is read synchronously when pages are picked, so the
        // stored value has to be pushed into the queue rather than pulled.
        setAutoIndexCap(p.autoIndexPages);
      })
      // A store that rejects outright (corrupt JSON) must not become an
      // unhandled rejection — defaults are already in state.
      .catch(() => {});
  }, []);

  const refreshPrefs = useCallback(async () => {
    const p = await loadPreferences();
    setPrefs(p);
    setFollowAgent(p.followAgentDefault);
    setIncludeViewingPage(p.includeViewingPageDefault);
    setAutoIndexCap(p.autoIndexPages);
    setPrefsRevision((r) => r + 1);
    return p;
  }, []);

  const toggleFollowAgent = useCallback(async () => {
    const prev = followAgent;
    const next = !prev;
    setFollowAgent(next);
    try {
      const p = await patchPreferences({ followAgentDefault: next });
      setPrefs(p);
    } catch {
      setFollowAgent(prev);
    }
  }, [followAgent]);

  const setIncludeViewingPageDefault = useCallback(async (value: boolean) => {
    const prev = includeViewingPage;
    setIncludeViewingPage(value);
    try {
      const p = await patchPreferences({ includeViewingPageDefault: value });
      setPrefs(p);
    } catch {
      setIncludeViewingPage(prev);
    }
  }, [includeViewingPage]);

  const setFollowAgentDefault = useCallback(async (value: boolean) => {
    const prev = followAgent;
    setFollowAgent(value);
    try {
      const p = await patchPreferences({ followAgentDefault: value });
      setPrefs(p);
    } catch {
      setFollowAgent(prev);
    }
  }, [followAgent]);

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
