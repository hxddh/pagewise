import { useEffect, useState } from "react";
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  type LlmSettings,
  type ProviderId,
} from "../lib/types";
import { loadSettings, saveSettings } from "../lib/settings";
import { loadPreferences, savePreferences, type ThemeMode } from "../lib/preferences";
import { settingsForProvider, testConnection } from "../lib/llm";

interface SettingsFormProps {
  onSaved?: () => void;
}

export function SettingsForm({ onSaved }: SettingsFormProps) {
  const [settings, setSettings] = useState<LlmSettings>(DEFAULT_SETTINGS);
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [status, setStatus] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadSettings().then(setSettings);
    loadPreferences().then((p) => setTheme(p.theme));
  }, []);

  function update(patch: Partial<LlmSettings>) {
    setSettings((s) => ({ ...s, ...patch }));
  }

  function onProviderChange(provider: ProviderId) {
    setSettings((s) => ({ ...s, ...settingsForProvider(provider, s) }));
  }

  async function handleSave() {
    setSaving(true);
    setStatus(null);
    try {
      await saveSettings(settings);
      await savePreferences({ theme });
      setStatus("Saved");
      onSaved?.();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setStatus(null);
    try {
      await saveSettings(settings);
      const reply = await testConnection(settings);
      setStatus(`Connected · ${reply}`);
      onSaved?.();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setTesting(false);
    }
  }

  const preset =
    settings.provider !== "custom"
      ? PROVIDER_PRESETS[settings.provider]
      : null;

  return (
    <div className="settings-form">
      <section className="settings-section">
        <h3>Appearance</h3>
        <div className="provider-grid theme-grid">
          {(
            [
              ["dark", "Dark"],
              ["light", "Light"],
              ["system", "System"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`provider-card ${theme === id ? "active" : ""}`}
              onClick={() => setTheme(id)}
            >
              <span className="provider-name">{label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h3>AI Provider</h3>
        <div className="provider-grid">
          {(
            Object.entries(PROVIDER_PRESETS) as [
              keyof typeof PROVIDER_PRESETS,
              (typeof PROVIDER_PRESETS)[keyof typeof PROVIDER_PRESETS],
            ][]
          ).map(([id, p]) => (
            <button
              key={id}
              type="button"
              className={`provider-card ${settings.provider === id ? "active" : ""}`}
              onClick={() => onProviderChange(id)}
            >
              <span className="provider-name">{p.label}</span>
            </button>
          ))}
          <button
            type="button"
            className={`provider-card ${settings.provider === "custom" ? "active" : ""}`}
            onClick={() => onProviderChange("custom")}
          >
            <span className="provider-name">Custom</span>
          </button>
        </div>
      </section>

      {settings.provider === "custom" && (
        <label>
          Base URL
          <input
            type="url"
            value={settings.baseURL ?? ""}
            onChange={(e) => update({ baseURL: e.target.value })}
            placeholder="https://api.example.com/v1"
          />
        </label>
      )}

      {preset && (
        <p className="hint">
          Endpoint <code>{preset.baseURL}</code>
        </p>
      )}

      <label>
        Model
        <input
          type="text"
          value={settings.model}
          onChange={(e) => update({ model: e.target.value })}
          placeholder={preset?.defaultModel ?? "model-id"}
        />
      </label>

      <label>
        API Key
        <input
          type="password"
          value={settings.apiKey}
          onChange={(e) => update({ apiKey: e.target.value })}
          placeholder={settings.provider === "ollama" ? "Not required" : "sk-…"}
          autoComplete="off"
        />
      </label>

      <div className="settings-actions">
        <button type="button" className="btn" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={handleTest}
          disabled={testing}
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
      </div>

      {status && (
        <p className={`status-line ${status.includes("fail") ? "error" : ""}`}>{status}</p>
      )}
    </div>
  );
}
