import { useCallback, useEffect, useRef } from "react";
import { saveSettings } from "../lib/settings";
import { settingsPersistSnapshot } from "../lib/redact-settings";
import type { LlmSettings } from "../lib/types";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

interface UseDebouncedSaveOptions {
  settings: LlmSettings;
  visionModel?: string;
  apiKeyDraft: string;
  apiKeyTouched: boolean;
  loaded: boolean;
  dirty: boolean;
  onPersisted?: (saved: LlmSettings) => void;
  onStatus?: (status: SaveStatus) => void;
}

export function useDebouncedSave({
  settings,
  visionModel = "",
  apiKeyDraft,
  apiKeyTouched,
  loaded,
  dirty,
  onPersisted,
  onStatus,
}: UseDebouncedSaveOptions) {
  const settingsRef = useRef(settings);
  const visionModelRef = useRef(visionModel);
  visionModelRef.current = visionModel;
  const draftRef = useRef(apiKeyDraft);
  const touchedRef = useRef(apiKeyTouched);
  const loadedRef = useRef(loaded);
  const dirtyRef = useRef(dirty);
  const lastSavedRef = useRef<string>("");
  const suppressUnmountPersistRef = useRef(false);
  const onPersistedRef = useRef(onPersisted);
  const onStatusRef = useRef(onStatus);

  settingsRef.current = settings;
  draftRef.current = apiKeyDraft;
  touchedRef.current = apiKeyTouched;
  loadedRef.current = loaded;
  dirtyRef.current = dirty;
  onPersistedRef.current = onPersisted;
  onStatusRef.current = onStatus;

  const discardPending = useCallback(() => {
    dirtyRef.current = false;
    suppressUnmountPersistRef.current = true;
  }, []);

  const buildToSave = useCallback((): LlmSettings => {
    const s = settingsRef.current;
    return {
      ...s,
      apiKey: touchedRef.current ? draftRef.current : s.apiKey,
    };
  }, []);

  const persist = useCallback(async (): Promise<LlmSettings | null> => {
    if (!loadedRef.current) return null;

    const toSave = buildToSave();
    const snap = settingsPersistSnapshot(toSave, visionModelRef.current);
    if (snap === lastSavedRef.current) return toSave;

    onStatusRef.current?.("saving");
    try {
      await saveSettings(toSave, visionModelRef.current);
      lastSavedRef.current = snap;
      onStatusRef.current?.("saved");
      onPersistedRef.current?.(toSave);
      return toSave;
    } catch {
      onStatusRef.current?.("error");
      return null;
    }
  }, [buildToSave]);

  useEffect(() => {
    if (!loaded || !dirty) return;
    const id = window.setTimeout(() => {
      void persist();
    }, 400);
    return () => window.clearTimeout(id);
  }, [settings, visionModel, apiKeyDraft, apiKeyTouched, loaded, dirty, persist]);

  useEffect(() => {
    if (!loaded) return;
    lastSavedRef.current = settingsPersistSnapshot(buildToSave(), visionModelRef.current);
  }, [loaded, buildToSave]);

  useEffect(() => {
    return () => {
      if (loadedRef.current && dirtyRef.current && !suppressUnmountPersistRef.current) {
        void persist();
      }
    };
  }, [persist]);

  return {
    persistNow: persist,
    markSaved: (saved: LlmSettings) => {
      lastSavedRef.current = settingsPersistSnapshot(saved, visionModelRef.current);
    },
    discardPending,
  };
}
