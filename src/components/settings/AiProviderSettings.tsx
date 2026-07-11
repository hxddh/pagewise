import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useI18n } from "../../i18n";
import { useDebouncedSave, type SaveStatus } from "../../hooks/useDebouncedSave";
import { useConnectionStatus } from "../../hooks/useConnectionStatus";
import { testConnection, testVisionConnection, validateAgentModel, validateModel, formatLlmError } from "../../lib/llm";
import {
  loadLlmStore,
  loadProviderSettings,
  saveProviderProfile,
  setActiveProvider,
} from "../../lib/settings";
import { isThinkingCapableModel } from "../../lib/model-capabilities";
import {
  agentPresetModels,
  DEFAULT_SETTINGS,
  defaultVisionModel,
  PROVIDER_PRESETS,
  visionPresetModels,
  type LlmSettings,
  type ProviderId,
  type ProviderProfile,
} from "../../lib/types";
import { IconCheck } from "../Icon";
import { SettingsSkeleton } from "./SettingsSkeleton";
import { ConnectionChip } from "./ConnectionChip";
import { ModelSelect } from "./ModelSelect";

interface AiProviderSettingsProps {
  onLlmSettingsSaved?: () => void;
  onReindexDoc?: () => void;
  onTestResult?: (message: string, ok: boolean) => void;
  onApiReady?: () => void;
  onSaveError?: () => void;
  onFooterState?: (state: AiSettingsFooterState | null) => void;
}

export interface AiSettingsFooterState {
  saveStatusLabel: string | null;
  saveStatus: SaveStatus;
  dirty: boolean;
  testing: boolean;
  settingActive: boolean;
  previewIsActive: boolean;
  canSetActive: boolean;
  onTest: () => void;
  onSetActive: () => void;
  onDiscard: () => Promise<void>;
}

const PRESET_IDS = Object.keys(PROVIDER_PRESETS) as (keyof typeof PROVIDER_PRESETS)[];

function resolveDraftSettings(
  settings: LlmSettings,
  apiKeyTouched: boolean,
  apiKeyDraft: string,
): LlmSettings {
  return {
    ...settings,
    apiKey: apiKeyTouched ? apiKeyDraft : settings.apiKey,
  };
}

export function AiProviderSettings({
  onLlmSettingsSaved,
  onReindexDoc,
  onTestResult,
  onApiReady,
  onSaveError,
  onFooterState,
}: AiProviderSettingsProps) {
  const { t } = useI18n();
  const { plaintextKeysOnDisk } = useConnectionStatus();
  const [activeProvider, setActiveProviderState] = useState<ProviderId>(DEFAULT_SETTINGS.provider);
  const [providerProfiles, setProviderProfiles] = useState<
    Partial<Record<ProviderId, ProviderProfile>>
  >({});
  const [settings, setSettings] = useState<LlmSettings>(DEFAULT_SETTINGS);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [settingActive, setSettingActive] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [customModel, setCustomModel] = useState(false);
  const [customVisionModel, setCustomVisionModel] = useState(false);
  const [visionModel, setVisionModel] = useState("");
  const [migratedNotice, setMigratedNotice] = useState(false);

  const profileCacheRef = useRef<Map<ProviderId, LlmSettings>>(new Map());
  const loadSeqRef = useRef(0);
  const lastPersistedVisionRef = useRef<string | null>(null);
  const settingsReadyRef = useRef(false);

  const previewProvider = settings.provider;
  const previewIsActive = previewProvider === activeProvider;
  const hasStoredKey = settings.apiKey.length > 0;

  useEffect(() => {
    let cancelled = false;
    void loadLlmStore().then(async (store) => {
      if (cancelled) return;
      setActiveProviderState(store.activeProvider);
      setProviderProfiles(store.profiles);
      const active = await loadProviderSettings(store.activeProvider);
      if (cancelled) return;
      profileCacheRef.current.set(store.activeProvider, active);
      setSettings(active);
      const profile = store.profiles[store.activeProvider];
      const vm =
        profile?.visionModel?.trim() ||
        (store.activeProvider !== "custom"
          ? defaultVisionModel(store.activeProvider as Exclude<ProviderId, "custom">)
          : "");
      setVisionModel(vm);
      setApiKeyDraft("");
      setApiKeyTouched(false);
      setDirty(false);
      const presetModels =
        active.provider !== "custom" ? agentPresetModels(active.provider) : [];
      setCustomModel(active.provider === "custom" || !presetModels.includes(active.model));
      const visionPresets =
        active.provider !== "custom" ? visionPresetModels(active.provider) : [];
      setCustomVisionModel(active.provider === "custom" || !visionPresets.includes(vm));
      lastPersistedVisionRef.current = vm;
      setMigratedNotice(
        active.model.includes("v4") &&
          localStorage.getItem("pagewise.modelMigrated") !== "1",
      );
      setLoaded(true);
      settingsReadyRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const cacheCurrentPreview = useCallback(() => {
    const draft = resolveDraftSettings(settings, apiKeyTouched, apiKeyDraft);
    profileCacheRef.current.set(previewProvider, draft);
    setProviderProfiles((prev) => ({
      ...prev,
      [previewProvider]: {
        model: draft.model,
        visionModel,
        baseURL: draft.baseURL,
        thinkingEnabled: draft.thinkingEnabled,
        webSearch: draft.webSearch,
        connectionVerified: draft.connectionVerified,
      },
    }));
  }, [previewProvider, settings, apiKeyTouched, apiKeyDraft, visionModel]);

  const applyLoadedSettings = useCallback(
    (next: LlmSettings, nextVisionModel?: string) => {
      setSettings(next);
      setApiKeyDraft("");
      setApiKeyTouched(false);
      setTestError(null);
      const presetModels =
        next.provider !== "custom" ? agentPresetModels(next.provider) : [];
      setCustomModel(next.provider === "custom" || !presetModels.includes(next.model));
      if (nextVisionModel !== undefined) {
        setVisionModel(nextVisionModel);
        const visionPresets =
          next.provider !== "custom" ? visionPresetModels(next.provider) : [];
        setCustomVisionModel(
          next.provider === "custom" || !visionPresets.includes(nextVisionModel),
        );
      }
    },
    [],
  );

  const handlePersisted = useCallback(
    (saved: LlmSettings) => {
      profileCacheRef.current.set(saved.provider, saved);
      setProviderProfiles((prev) => ({
        ...prev,
        [saved.provider]: {
          model: saved.model,
          visionModel,
          baseURL: saved.baseURL,
          thinkingEnabled: saved.thinkingEnabled,
          webSearch: saved.webSearch,
          connectionVerified: saved.connectionVerified,
        },
      }));
      if (saved.provider === previewProvider) {
        setSettings(saved);
        setApiKeyTouched(false);
        setApiKeyDraft("");
        setDirty(false);
      }
      if (saved.provider === activeProvider) {
        onLlmSettingsSaved?.();
        if (
          settingsReadyRef.current &&
          lastPersistedVisionRef.current !== visionModel
        ) {
          lastPersistedVisionRef.current = visionModel;
          onReindexDoc?.();
        }
      } else {
        onTestResult?.(t("settings.savedPreviewNotActive"), true);
      }
    },
    [previewProvider, activeProvider, onLlmSettingsSaved, onReindexDoc, visionModel, onTestResult, t],
  );

  const { persistNow, markSaved, discardPending } = useDebouncedSave({
    settings,
    visionModel,
    apiKeyDraft,
    apiKeyTouched,
    loaded,
    dirty,
    onPersisted: handlePersisted,
    onStatus: setSaveStatus,
    onUnchanged: () => {
      setDirty(false);
      setSaveStatus("idle");
    },
  });

  const handleDiscard = useCallback(async () => {
    discardPending();
    const persisted = await loadProviderSettings(previewProvider);
    profileCacheRef.current.set(previewProvider, persisted);
    const profile = providerProfiles[previewProvider];
    const vm =
      profile?.visionModel?.trim() ||
      (previewProvider !== "custom"
        ? defaultVisionModel(previewProvider as Exclude<ProviderId, "custom">)
        : "");
    applyLoadedSettings(persisted, vm);
    markSaved(persisted);
    setDirty(false);
    setSaveStatus("idle");
  }, [
    applyLoadedSettings,
    discardPending,
    markSaved,
    previewProvider,
    providerProfiles,
  ]);

  function markDirty() {
    setDirty(true);
    setSaveStatus("idle");
  }

  function patchSettings(patch: Partial<LlmSettings>) {
    setSettings((s) => {
      const next = { ...s, ...patch, connectionVerified: false };
      profileCacheRef.current.set(next.provider, next);
      return next;
    });
    setTestError(null);
    markDirty();
  }

  function onProviderChange(provider: ProviderId) {
    if (provider === previewProvider) return;

    void (async () => {
      if (dirty) {
        const saved = await persistNow();
        if (!saved) {
          setSaveStatus("error");
          onSaveError?.();
          return;
        }
      }

      cacheCurrentPreview();
      const seq = ++loadSeqRef.current;

      const cached = profileCacheRef.current.get(provider);
      if (cached) {
        const profile = providerProfiles[provider];
        const vm =
          profile?.visionModel?.trim() ||
          (provider !== "custom"
            ? defaultVisionModel(provider as Exclude<ProviderId, "custom">)
            : "");
        applyLoadedSettings(cached, vm);
        setDirty(false);
        setSaveStatus("idle");
        return;
      }

      const loadedSettings = await loadProviderSettings(provider);
      if (seq !== loadSeqRef.current) return;
      profileCacheRef.current.set(provider, loadedSettings);
      const profile = providerProfiles[provider];
      const vm =
        profile?.visionModel?.trim() ||
        (provider !== "custom"
          ? defaultVisionModel(provider as Exclude<ProviderId, "custom">)
          : "");
      applyLoadedSettings(loadedSettings, vm);
      setDirty(false);
      setSaveStatus("idle");
    })();
  }

  function onAgentPresetSelect(value: string) {
    setCustomModel(false);
    const patch: Partial<LlmSettings> = { model: value };
    if (!isThinkingCapableModel(settings.provider, value)) {
      patch.thinkingEnabled = false;
    }
    patchSettings(patch);
  }

  function onAgentCustomChange(value: string) {
    setCustomModel(true);
    const patch: Partial<LlmSettings> = { model: value };
    if (!isThinkingCapableModel(settings.provider, value)) {
      patch.thinkingEnabled = false;
    }
    patchSettings(patch);
  }

  async function handleSave() {
    const saved = await persistNow();
    if (saved) markSaved(saved);
  }

  function onScanPresetSelect(value: string) {
    setCustomVisionModel(false);
    setVisionModel(value);
    markDirty();
  }

  function onScanCustomChange(value: string) {
    setCustomVisionModel(true);
    setVisionModel(value);
    markDirty();
  }

  const handleSetActive = useCallback(async () => {
    setSettingActive(true);
    try {
      const draft = resolveDraftSettings(settings, apiKeyTouched, apiKeyDraft);
      const agentError = validateAgentModel(draft, t);
      if (agentError) throw new Error(agentError);

      const saved = await persistNow();
      if (!saved) throw new Error(t("errors.saveFailed"));
      const next = await setActiveProvider(previewProvider);
      profileCacheRef.current.set(previewProvider, next);
      setActiveProviderState(previewProvider);
      setSettings(next);
      setDirty(false);
      setSaveStatus("saved");
      markSaved(next);
      onLlmSettingsSaved?.();
      const prevVision = providerProfiles[previewProvider]?.visionModel?.trim() ?? "";
      const visionChanged = visionModel.trim() !== prevVision;
      if (visionChanged) {
        lastPersistedVisionRef.current = visionModel;
        onReindexDoc?.();
      }
      if (next.connectionVerified) onApiReady?.();
    } catch (err) {
      setSaveStatus("error");
      const message =
        err instanceof Error && err.message ? err.message : t("errors.saveFailed");
      setTestError(message);
      onSaveError?.();
    } finally {
      setSettingActive(false);
    }
  }, [
    persistNow,
    previewProvider,
    settings,
    apiKeyTouched,
    apiKeyDraft,
    t,
    markSaved,
    onLlmSettingsSaved,
    onReindexDoc,
    onApiReady,
    onSaveError,
    providerProfiles,
    visionModel,
  ]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestError(null);
    try {
      const toTest = resolveDraftSettings(settings, apiKeyTouched, apiKeyDraft);
      const modelError = validateModel(toTest, t);
      if (modelError) throw new Error(modelError);

      const reply = await testConnection(toTest, t);
      const scanModel = visionModel.trim();
      if (scanModel) {
        await testVisionConnection({ ...toTest, model: scanModel }, t);
      }

      const saved = await saveProviderProfile(
        toTest.provider,
        {
          model: toTest.model,
          visionModel,
          baseURL: toTest.baseURL,
          thinkingEnabled: toTest.thinkingEnabled,
          connectionVerified: true,
        },
        apiKeyTouched ? toTest.apiKey : undefined,
      );
      setSettings(saved);
      profileCacheRef.current.set(saved.provider, saved);
      markSaved(saved);
      if (apiKeyTouched) {
        setApiKeyTouched(false);
        setApiKeyDraft("");
      }

      setProviderProfiles((prev) => ({
        ...prev,
        [saved.provider]: {
          model: saved.model,
          visionModel,
          baseURL: saved.baseURL,
          thinkingEnabled: saved.thinkingEnabled,
          webSearch: saved.webSearch,
          connectionVerified: true,
        },
      }));
      setDirty(false);
      setSaveStatus("saved");
      localStorage.setItem("pagewise.modelMigrated", "1");
      setMigratedNotice(false);
      if (saved.provider === activeProvider) {
        onLlmSettingsSaved?.();
        onApiReady?.();
        const visionChanged =
          visionModel.trim() !== (lastPersistedVisionRef.current?.trim() ?? "");
        if (visionChanged) {
          onReindexDoc?.();
        }
        lastPersistedVisionRef.current = visionModel;
      }
      onTestResult?.(
        scanModel && saved.provider !== "custom" && visionPresetModels(saved.provider).length > 0
          ? t("settings.testSuccessWithScan", { reply })
          : t("settings.testSuccess", { reply }),
        true,
      );
    } catch (e) {
      const display = e instanceof Error ? e.message : formatLlmError(e, t);
      setTestError(display);
      onTestResult?.(display, false);
    } finally {
      setTesting(false);
    }
  }, [
    settings,
    apiKeyTouched,
    apiKeyDraft,
    t,
    markSaved,
    activeProvider,
    onLlmSettingsSaved,
    onTestResult,
    onApiReady,
    onReindexDoc,
    visionModel,
  ]);

  const preset =
    settings.provider !== "custom" ? PROVIDER_PRESETS[settings.provider] : null;

  const saveStatusLabel =
    saveStatus === "saving"
      ? t("settings.saving")
      : saveStatus === "saved"
        ? t("settings.saved")
        : saveStatus === "error"
          ? t("settings.saveFailed")
          : dirty
            ? t("settings.unsaved")
            : !previewIsActive
              ? t("settings.previewMode")
              : null;

  const showThinking =
    settings.provider !== "custom" &&
    isThinkingCapableModel(settings.provider, settings.model);

  const canSetActive = !previewIsActive;

  useEffect(() => {
    if (saveStatus === "error") onSaveError?.();
  }, [saveStatus, onSaveError]);

  useEffect(() => {
    if (!loaded) {
      onFooterState?.(null);
      return;
    }
    onFooterState?.({
      saveStatusLabel,
      saveStatus,
      dirty,
      testing,
      settingActive,
      previewIsActive,
      canSetActive,
      onTest: () => void handleTest(),
      onSetActive: () => void handleSetActive(),
      onDiscard: handleDiscard,
    });
  }, [
    loaded,
    saveStatusLabel,
    saveStatus,
    dirty,
    testing,
    settingActive,
    previewIsActive,
    canSetActive,
    handleTest,
    handleSetActive,
    handleDiscard,
    onFooterState,
  ]);

  useEffect(() => {
    return () => onFooterState?.(null);
  }, [onFooterState]);

  if (!loaded) {
    return <SettingsSkeleton />;
  }

  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <h3 className="settings-page-title">{t("settings.aiProvider")}</h3>
        <ConnectionChip
          settings={settings}
          activeProvider={activeProvider}
          apiKeyTouched={apiKeyTouched}
          apiKeyDraft={apiKeyDraft}
          dirty={dirty}
        />
      </div>

      {migratedNotice && (
        <div className="settings-callout" role="note">
          <span>{t("settings.modelMigrated")}</span>
          <button
            type="button"
            className="settings-callout-dismiss"
            onClick={() => setMigratedNotice(false)}
            aria-label={t("common.dismiss")}
          >
            ×
          </button>
        </div>
      )}

      {plaintextKeysOnDisk && (
        <div className="settings-callout settings-callout-warning" role="alert">
          <span>{t("settings.plaintextKeysWarning")}</span>
        </div>
      )}

      {testError && (
        <p className="settings-error-banner" role="alert">
          {testError}
        </p>
      )}

      <section className="settings-card">
        <h4 className="settings-card-title">{t("settings.connectionSection")}</h4>
        <p className="settings-card-hint">{t("settings.providerHint")}</p>
        <div className="provider-grid">
          {PRESET_IDS.map((id) => {
            const isPreview = previewProvider === id;
            const isActive = activeProvider === id;
            return (
              <button
                key={id}
                type="button"
                className={`provider-cell ${isPreview ? "active" : ""} ${isActive ? "in-use" : ""}`}
                onClick={() => onProviderChange(id)}
                title={isActive ? t("settings.providerCurrentlyActive") : undefined}
              >
                <span className="provider-cell-label">{PROVIDER_PRESETS[id].label}</span>
                {isPreview && <IconCheck size={14} />}
              </button>
            );
          })}
          <button
            type="button"
            className={`provider-cell provider-cell-wide ${previewProvider === "custom" ? "active" : ""} ${activeProvider === "custom" ? "in-use" : ""}`}
            onClick={() => onProviderChange("custom")}
            title={activeProvider === "custom" ? t("settings.providerCurrentlyActive") : undefined}
          >
            <span className="provider-cell-label">{t("settings.providerCustom")}</span>
            {previewProvider === "custom" && <IconCheck size={14} />}
          </button>
        </div>
        {preset && (
          <p className="provider-endpoint">
            {t("settings.endpoint")}{" "}
            <code>{preset.baseURL}</code>
          </p>
        )}

        <div className="settings-card-divider" />

        <div className="settings-field">
          <div className="settings-field-meta">
            <span className="settings-field-label">{t("settings.apiKey")}</span>
            {hasStoredKey && !apiKeyTouched && (
              <span className="settings-field-badge">{t("settings.apiKeySaved")}</span>
            )}
          </div>
          <div className="settings-input-row">
            <input
              className="settings-input"
              type={showKey ? "text" : "password"}
              value={apiKeyDraft}
              onChange={(e) => {
                setApiKeyDraft(e.target.value);
                setApiKeyTouched(true);
                setSettings((s) => {
                  const next = { ...s, connectionVerified: false };
                  profileCacheRef.current.set(next.provider, next);
                  return next;
                });
                setTestError(null);
                markDirty();
              }}
              placeholder={
                settings.provider === "ollama"
                  ? t("settings.apiKeyNotRequired")
                  : hasStoredKey && !apiKeyTouched
                    ? "••••••••"
                    : t("settings.apiKeyPlaceholder")
              }
              onBlur={() => void handleSave()}
              autoComplete="off"
            />
            <button
              type="button"
              className="settings-icon-btn"
              onClick={() => setShowKey((s) => !s)}
              aria-label={showKey ? t("settings.hideKey") : t("settings.showKey")}
            >
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>
      </section>

      {settings.provider === "custom" && (
        <section className="settings-card">
          <h4 className="settings-card-title">{t("settings.modelsSection")}</h4>
          <p className="settings-card-hint">{t("settings.customModelsHint")}</p>
          <label className="settings-field">
            <span className="settings-field-label">{t("settings.baseUrl")}</span>
            <input
              className="settings-input"
              type="url"
              value={settings.baseURL ?? ""}
              onChange={(e) => patchSettings({ baseURL: e.target.value })}
              placeholder="https://api.example.com"
            />
          </label>
          <label className="settings-field">
            <span className="settings-field-label">{t("settings.model")}</span>
            <input
              className="settings-input"
              type="text"
              value={settings.model}
              onChange={(e) => patchSettings({ model: e.target.value })}
              placeholder="model-id"
            />
          </label>
          <label className="settings-field">
            <span className="settings-field-label">{t("settings.scanModel")}</span>
            <p className="settings-field-hint">{t("settings.customScanModelHint")}</p>
            <input
              className="settings-input"
              type="text"
              value={visionModel}
              onChange={(e) => {
                setVisionModel(e.target.value);
                markDirty();
              }}
              placeholder={t("settings.scanModelOptionalPlaceholder")}
            />
          </label>
        </section>
      )}

      {settings.provider !== "custom" && (
        <section className="settings-card">
          <h4 className="settings-card-title">{t("settings.modelsSection")}</h4>
          <p className="settings-card-hint">{t("settings.modelsSectionHint")}</p>

          <ModelSelect
            provider={settings.provider}
            model={settings.model}
            customModel={customModel}
            purpose="agent"
            onPresetSelect={onAgentPresetSelect}
            onCustomChange={onAgentCustomChange}
            onEnterCustom={() => setCustomModel(true)}
          />

          {visionPresetModels(settings.provider).length > 0 ? (
            <>
              <div className="settings-card-divider" />
              <ModelSelect
                provider={settings.provider}
                model={visionModel}
                customModel={customVisionModel}
                purpose="vision"
                onPresetSelect={onScanPresetSelect}
                onCustomChange={onScanCustomChange}
                onEnterCustom={() => setCustomVisionModel(true)}
              />
            </>
          ) : (
            <>
              <div className="settings-card-divider" />
              <p className="settings-field-hint">{t("settings.scanUnavailableHint")}</p>
              <label className="settings-field">
                <span className="settings-field-label">{t("settings.scanModel")}</span>
                <p className="settings-field-hint">{t("settings.scanModelOptionalHint")}</p>
                <input
                  className="settings-input"
                  type="text"
                  value={visionModel}
                  onChange={(e) => {
                    setVisionModel(e.target.value);
                    markDirty();
                  }}
                  placeholder={t("settings.scanModelOptionalPlaceholder")}
                />
              </label>
            </>
          )}
        </section>
      )}

      {showThinking && (
        <section className="settings-card">
          <h4 className="settings-card-title">{t("settings.advancedSection")}</h4>
          <label className="settings-row-toggle">
            <div>
              <span className="settings-row-title">{t("settings.thinkingMode")}</span>
              <span className="settings-row-hint">{t("settings.thinkingHint")}</span>
            </div>
            <input
              type="checkbox"
              checked={!!settings.thinkingEnabled}
              onChange={(e) => patchSettings({ thinkingEnabled: e.target.checked })}
            />
          </label>
        </section>
      )}

      {settings.provider === "openrouter" && (
        <section className="settings-card">
          <h4 className="settings-card-title">{t("settings.webSearchSection")}</h4>
          <label className="settings-row-toggle">
            <div>
              <span className="settings-row-title">{t("settings.webSearch")}</span>
              <span className="settings-row-hint">{t("settings.webSearchHint")}</span>
            </div>
            <input
              type="checkbox"
              checked={!!settings.webSearch}
              onChange={(e) => patchSettings({ webSearch: e.target.checked })}
            />
          </label>
        </section>
      )}
    </div>
  );
}
