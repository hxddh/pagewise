import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { useDebouncedSave, type SaveStatus } from "../../hooks/useDebouncedSave";
import { useConnectionStatus } from "../../hooks/useConnectionStatus";
import { formatLlmError, testConnection, testVisionConnection, validateModel } from "../../lib/llm";
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
import { ApiKeyField } from "./ApiKeyField";
import { AdvancedRows } from "./AdvancedRows";
import { ModelSelect } from "./ModelSelect";
import { ProviderGrid } from "./ProviderGrid";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";

/**
 * The assistant, once it is configured.
 *
 * One visible row and one disclosure. The model is chosen for the reader from
 * the provider's preset table — the row says so and offers "Change" for the
 * reader who wants a specific one. Provider, key, scan model, thinking, the
 * current-page screenshot switch and the text cache are real choices but not
 * everyday ones, so they live behind Advanced (`AdvancedRows.tsx`), together
 * with the connection test. Switching a provider *is* using it: 18.0 removed
 * the "Set active" step that made editing and using two different things.
 */
interface AssistantSettingsProps {
  onLlmSettingsSaved?: () => void;
  onReindexDoc?: () => void;
  onApiReady?: () => void;
  onTestResult?: (message: string, ok: boolean) => void;
  onSaveError?: () => void;
  onRefreshConnection?: () => void;
  includeViewingPageDefault: boolean;
  onIncludeViewingPageDefaultChange: (value: boolean) => void;
  showUsageLine: boolean;
  onShowUsageLineChange: (value: boolean) => void;
}

function visionModelOf(profile: ProviderProfile | undefined, provider: ProviderId): string {
  return (
    profile?.visionModel?.trim() ||
    (provider !== "custom" ? defaultVisionModel(provider as Exclude<ProviderId, "custom">) : "")
  );
}

export function AssistantSettings({
  onLlmSettingsSaved,
  onReindexDoc,
  onApiReady,
  onTestResult,
  onSaveError,
  onRefreshConnection,
  includeViewingPageDefault,
  onIncludeViewingPageDefaultChange,
  showUsageLine,
  onShowUsageLineChange,
}: AssistantSettingsProps) {
  const { t } = useI18n();
  const { plaintextKeysOnDisk } = useConnectionStatus();
  const [loaded, setLoaded] = useState(false);
  const [activeProvider, setActiveProviderId] = useState<ProviderId>(DEFAULT_SETTINGS.provider);
  const [settings, setSettings] = useState<LlmSettings>(DEFAULT_SETTINGS);
  const [visionModel, setVisionModel] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customModel, setCustomModel] = useState(false);
  const [customVisionModel, setCustomVisionModel] = useState(false);
  const lastPersistedVisionRef = useRef<string | null>(null);

  const applyLoaded = useCallback((next: LlmSettings, nextVision: string) => {
    setSettings(next);
    setVisionModel(nextVision);
    setApiKeyDraft("");
    setApiKeyTouched(false);
    setError(null);
    const presets = next.provider !== "custom" ? agentPresetModels(next.provider) : [];
    setCustomModel(next.provider === "custom" || !presets.includes(next.model));
    const visionPresets = next.provider !== "custom" ? visionPresetModels(next.provider) : [];
    setCustomVisionModel(next.provider === "custom" || !visionPresets.includes(nextVision));
    lastPersistedVisionRef.current = nextVision;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const store = await loadLlmStore();
      const provider = store.activeProvider;
      const loadedSettings = await loadProviderSettings(provider);
      if (cancelled) return;
      setActiveProviderId(provider);
      applyLoaded(loadedSettings, visionModelOf(store.profiles[provider], provider));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyLoaded]);

  const handlePersisted = useCallback(
    (saved: LlmSettings) => {
      setSettings(saved);
      setApiKeyTouched(false);
      setApiKeyDraft("");
      setDirty(false);
      onLlmSettingsSaved?.();
      onRefreshConnection?.();
      if (lastPersistedVisionRef.current !== visionModel) {
        lastPersistedVisionRef.current = visionModel;
        onReindexDoc?.();
      }
    },
    [visionModel, onLlmSettingsSaved, onReindexDoc, onRefreshConnection],
  );

  const { persistNow, markSaved } = useDebouncedSave({
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

  function patchSettings(patch: Partial<LlmSettings>) {
    setSettings((s) => ({ ...s, ...patch, connectionVerified: false }));
    setError(null);
    setDirty(true);
    setSaveStatus("idle");
  }

  async function switchProvider(next: ProviderId) {
    if (next === settings.provider) return;
    const saved = await persistNow();
    if (!saved) {
      setError(t("errors.saveFailed"));
      onSaveError?.();
      return;
    }
    const loadedSettings = await setActiveProvider(next);
    const store = await loadLlmStore();
    applyLoaded(loadedSettings, visionModelOf(store.profiles[next], next));
    setActiveProviderId(next);
    setDirty(false);
    onLlmSettingsSaved?.();
    onRefreshConnection?.();
  }

  async function handleTest() {
    setTesting(true);
    setError(null);
    try {
      const draft = { ...settings, apiKey: apiKeyTouched ? apiKeyDraft : settings.apiKey };
      const modelError = validateModel(draft, t);
      if (modelError) throw new Error(modelError);
      const reply = await testConnection(draft, t);
      if (visionModel.trim()) {
        await testVisionConnection({ ...draft, model: visionModel.trim() }, t);
      }
      const saved = await saveProviderProfile(
        settings.provider,
        {
          model: draft.model,
          visionModel,
          baseURL: draft.baseURL,
          thinkingEnabled: draft.thinkingEnabled,
          connectionVerified: true,
        },
        apiKeyTouched ? draft.apiKey : undefined,
      );
      markSaved(saved);
      setSettings(saved);
      setApiKeyTouched(false);
      setApiKeyDraft("");
      setDirty(false);
      setSaveStatus("saved");
      onLlmSettingsSaved?.();
      onRefreshConnection?.();
      onApiReady?.();
      onTestResult?.(t("settings.testSuccess", { reply }), true);
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : formatLlmError(e, t);
      setError(message);
      setSaveStatus("error");
      onSaveError?.();
      onTestResult?.(message, false);
    } finally {
      setTesting(false);
    }
  }

  const presets = settings.provider !== "custom" ? agentPresetModels(settings.provider) : [];
  const automatic = presets.length > 0 && settings.model === presets[0] && !customModel;
  const showThinking =
    settings.provider !== "custom" && isThinkingCapableModel(settings.provider, settings.model);
  const preset = settings.provider !== "custom" ? PROVIDER_PRESETS[settings.provider] : null;
  const visionPresets = settings.provider !== "custom" ? visionPresetModels(settings.provider) : [];

  return (
    <section className="settings-card">
      <h4 className="settings-card-title">{t("settings.assistantGroup")}</h4>

      <div className="settings-row">
        <div>
          <span className="settings-row-title">{t("settings.assistantModel")}</span>
          <span className="settings-row-hint">
            {automatic ? t("settings.modelAutomatic") : settings.model}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setModelOpen((o) => !o)}
          aria-expanded={modelOpen}
        >
          {modelOpen ? t("settings.modelClose") : t("settings.modelChange")}
        </Button>
      </div>
      {modelOpen && (
        <ModelSelect
          provider={settings.provider as Exclude<ProviderId, "custom">}
          model={settings.model}
          customModel={customModel}
          purpose="agent"
          onPresetSelect={(value) => {
            setCustomModel(false);
            patchSettings({
              model: value,
              ...(isThinkingCapableModel(settings.provider, value) ? {} : { thinkingEnabled: false }),
            });
          }}
          onCustomChange={(value) => {
            setCustomModel(true);
            patchSettings({
              model: value,
              ...(isThinkingCapableModel(settings.provider, value) ? {} : { thinkingEnabled: false }),
            });
          }}
          onEnterCustom={() => setCustomModel(true)}
        />
      )}

      <label className="settings-row-toggle">
        <div>
          <span className="settings-row-title">{t("settings.showUsageLine")}</span>
          <span className="settings-row-hint">{t("settings.showUsageLineHint")}</span>
        </div>
        <input
          type="checkbox"
          checked={showUsageLine}
          onChange={(e) => onShowUsageLineChange(e.target.checked)}
        />
      </label>

      {error && (
        <p className="settings-error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="settings-card-divider" />

      <div className="settings-row">
        <div>
          <span className="settings-row-title">{t("settings.advancedSection")}</span>
          <span className="settings-row-hint">
            {preset ? preset.baseURL : t("settings.providerCustom")}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
          aria-label={t("settings.advancedSection")}
        >
          {advancedOpen ? t("settings.modelClose") : t("settings.modelChange")}
        </Button>
      </div>

      {advancedOpen && (
        <div className="settings-advanced">
          <ProviderGrid preview={settings.provider} active={activeProvider} onSelect={(id) => void switchProvider(id)} />
          <ApiKeyField
            provider={settings.provider}
            value={apiKeyDraft}
            touched={apiKeyTouched}
            hasStoredKey={!!settings.apiKey}
            onChange={(next) => {
              setApiKeyDraft(next);
              setApiKeyTouched(true);
              setSettings((s) => ({ ...s, connectionVerified: false }));
              setError(null);
              setDirty(true);
            }}
            onCommit={() => void persistNow()}
          />

          {settings.provider === "custom" && (
            <Field label={t("settings.baseUrl")}>
              {({ id }) => (
                <Input
                  id={id}
                  className="settings-input"
                  type="url"
                  value={settings.baseURL ?? ""}
                  onChange={(e) => patchSettings({ baseURL: e.target.value })}
                  placeholder="https://api.example.com"
                />
              )}
            </Field>
          )}

          {settings.provider !== "custom" && visionPresets.length > 0 && (
            <ModelSelect
              provider={settings.provider as Exclude<ProviderId, "custom">}
              model={visionModel}
              customModel={customVisionModel}
              purpose="vision"
              onPresetSelect={(value) => {
                setCustomVisionModel(false);
                setVisionModel(value);
                setDirty(true);
              }}
              onCustomChange={(value) => {
                setCustomVisionModel(true);
                setVisionModel(value);
                setDirty(true);
              }}
              onEnterCustom={() => setCustomVisionModel(true)}
            />
          )}
          {(settings.provider === "custom" || visionPresets.length === 0) && (
            <Field label={t("settings.scanModel")} hint={t("settings.scanModelHint")}>
              {({ id, "aria-describedby": describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  className="settings-input"
                  type="text"
                  value={visionModel}
                  onChange={(e) => {
                    setVisionModel(e.target.value);
                    setDirty(true);
                  }}
                />
              )}
            </Field>
          )}

          <AdvancedRows
            includeViewingPageDefault={includeViewingPageDefault}
            onIncludeViewingPageDefaultChange={onIncludeViewingPageDefaultChange}
            showThinking={showThinking}
            thinkingEnabled={!!settings.thinkingEnabled}
            onThinkingChange={(value) => patchSettings({ thinkingEnabled: value })}
          />

          <div className="settings-row">
            <span className="settings-row-hint">
              {saveStatus === "saving"
                ? t("settings.saving")
                : saveStatus === "saved"
                  ? t("settings.saved")
                  : saveStatus === "error"
                    ? t("settings.saveFailed")
                    : dirty
                      ? t("settings.unsaved")
                      : t("settings.autoSaved")}
            </span>
            <Button variant="secondary" size="sm" disabled={testing} onClick={() => void handleTest()}>
              {testing ? t("settings.testing") : t("settings.testConnection")}
            </Button>
          </div>

          {plaintextKeysOnDisk && (
            <p className="settings-callout settings-callout-warning" role="alert">
              {t("settings.plaintextKeysWarning")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
