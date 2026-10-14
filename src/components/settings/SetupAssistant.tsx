import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { loadProviderSettings, saveProviderProfile, setActiveProvider } from "../../lib/settings";
import { isToolModel } from "../../lib/model-capabilities";
import {
  defaultVisionModel,
  PROVIDER_PRESETS,
  type LlmSettings,
  type ProviderId,
} from "../../lib/types";
import { ApiKeyField } from "./ApiKeyField";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";

/**
 * The one page a new reader sees.
 *
 * Before 18.0 this was a settings drawer with four tabs, five providers, an
 * assistant model, a scan model, a thinking switch and a "Set active" button
 * that separated editing from using — six clicks and a paste before the first
 * question, and three concepts (provider, assistant model, scan model) to
 * understand first. This page asks for one decision and one key, chooses the
 * model from the provider's own preset table, and puts everything else behind
 * "Advanced". "Start reading" is the end of setup: it saves, makes the provider
 * active, and the caller opens the document picker.
 */
interface SetupAssistantProps {
  /** Called once the key is saved and the provider is active. */
  onDone: () => void;
  /** The reader asked for the full settings surface instead (Ollama, custom). */
  onSkip: () => void;
  onSaveError?: () => void;
  onRefreshConnection?: () => void;
}

const SETUP_PROVIDERS: Array<Exclude<ProviderId, "custom">> = ["openai", "deepseek", "openrouter"];

export function SetupAssistant({ onDone, onSkip, onSaveError, onRefreshConnection }: SetupAssistantProps) {
  const { t } = useI18n();
  const [provider, setProvider] = useState<ProviderId>("deepseek");
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [existing, setExisting] = useState<LlmSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadProviderSettings(provider).then((loaded) => {
      if (cancelled) return;
      setExisting(loaded);
      setBaseURL(loaded.baseURL ?? "");
      setModel(loaded.model);
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const preset = provider !== "custom" ? PROVIDER_PRESETS[provider] : null;
  const effectiveModel = model || preset?.defaultModel || "";
  const canStart = keyDraft.trim().length > 0 && !busy;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      if (provider === "custom" && (!baseURL.trim() || !model.trim())) {
        throw new Error(t("settings.customNeedsEndpoint"));
      }
      const saved = await saveProviderProfile(
        provider,
        {
          model: effectiveModel,
          visionModel: provider === "custom" ? "" : defaultVisionModel(provider),
          baseURL: provider === "custom" ? baseURL.trim() : undefined,
          connectionVerified: false,
        },
        keyDraft,
      );
      if (!isToolModel(provider, saved.model) && provider !== "custom") {
        // The key is saved either way — a model without tool calling can still
        // be switched later, and refusing to save would lose the key.
        throw new Error(t("settings.agentNeedTools"));
      }
      await setActiveProvider(provider);
      onRefreshConnection?.();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errors.saveFailed"));
      onSaveError?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-page setup-page">
      <div className="setup-providers">
        {SETUP_PROVIDERS.map((id) => (
          // raw-button: a provider tile is a card-shaped choice, not a button; Button would give it a box
          <button
            key={id}
            type="button"
            className={`provider-cell ${provider === id ? "active" : ""}`}
            aria-pressed={provider === id}
            onClick={() => setProvider(id)}
          >
            {PROVIDER_PRESETS[id].label}
          </button>
        ))}
      </div>
      {/* raw-button: a text link into the full settings surface; Button would give it a box */}
      <button type="button" className="setup-more" onClick={onSkip}>
        {t("settings.setupSomethingElse")}
      </button>

      {existing?.apiKey && provider === existing.provider && (
        <p className="settings-row-hint">{t("settings.apiKeySaved")}</p>
      )}

      <ApiKeyField
        provider={provider}
        value={keyDraft}
        touched={keyDraft.length > 0}
        hasStoredKey={!!existing?.apiKey}
        onChange={(next) => {
          setKeyDraft(next);
          setError(null);
        }}
        onCommit={() => void start()}
      />

      {advanced && (
        <div className="setup-advanced">
          {provider === "custom" ? (
            <>
              <Field label={t("settings.baseUrl")}>
                {({ id }) => (
                  <Input
                    id={id}
                    className="settings-input"
                    type="url"
                    value={baseURL}
                    onChange={(e) => setBaseURL(e.target.value)}
                    placeholder="https://api.example.com"
                  />
                )}
              </Field>
              <Field label={t("settings.model")}>
                {({ id }) => (
                  <Input
                    id={id}
                    className="settings-input"
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="model-id"
                  />
                )}
              </Field>
            </>
          ) : (
            <Field label={t("settings.model")} hint={t("settings.setupModelHint")}>
              {({ id, "aria-describedby": describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  className="settings-input"
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              )}
            </Field>
          )}
        </div>
      )}

      {error && (
        <p className="settings-error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="setup-actions">
        <Button variant="primary" size="lg" disabled={!canStart} onClick={() => void start()}>
          {busy ? t("settings.setupStarting") : t("settings.setupStart")}
        </Button>
        <Button variant="link" size="sm" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
          {t("settings.setupAdvanced")}
        </Button>
      </div>

      <p className="setup-note">{t("settings.setupNote")}</p>
    </div>
  );
}
