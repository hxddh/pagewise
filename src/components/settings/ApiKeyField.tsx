import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import type { ProviderId } from "../../lib/types";

/** Where a user gets an API key for each provider (absent = no key page). */
const API_KEY_HELP_URL: Partial<Record<ProviderId, string>> = {
  openai: "https://platform.openai.com/api-keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  openrouter: "https://openrouter.ai/keys",
};

interface ApiKeyFieldProps {
  provider: ProviderId;
  value: string;
  /** True once the user has typed — the stored key is masked until then. */
  touched: boolean;
  /** True when a key is already saved for this provider. */
  hasStoredKey: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
}

/**
 * The API key input, its reveal toggle, and the link to where a key comes from.
 *
 * Split out of AiProviderSettings. `showKey` moves here with it — whether the
 * characters are visible is this field's own business and nothing else in the
 * panel read it, so it is one less thing in a component that had eighteen
 * pieces of state.
 */
export function ApiKeyField({
  provider,
  value,
  touched,
  hasStoredKey,
  onChange,
  onCommit,
}: ApiKeyFieldProps) {
  const { t } = useI18n();
  const [showKey, setShowKey] = useState(false);
  const helpUrl = API_KEY_HELP_URL[provider];

  return (
    <Field
      label={
        <span className="settings-field-meta">
          {t("settings.apiKey")}
          {hasStoredKey && !touched && (
            <span className="settings-field-badge">{t("settings.apiKeySaved")}</span>
          )}
          {helpUrl && (
            <Button
              variant="link"
              size="sm"
              className="settings-field-help-link"
              onClick={() => void openUrl(helpUrl)}
            >
              {t("settings.getApiKey")}
            </Button>
          )}
        </span>
      }
    >
      {({ id, "aria-describedby": describedBy }) => (
      <div className="settings-input-row">
        <Input
          id={id}
          aria-describedby={describedBy}
          className="settings-input"
          type={showKey ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            provider === "ollama"
              ? t("settings.apiKeyNotRequired")
              : hasStoredKey && !touched
                ? "••••••••"
                : t("settings.apiKeyPlaceholder")
          }
          onBlur={onCommit}
          autoComplete="off"
        />
        <Button
          variant="ghost"
          size="lg"
          icon
          className="settings-icon-btn"
          onClick={() => setShowKey((s) => !s)}
          aria-label={showKey ? t("settings.hideKey") : t("settings.showKey")}
        >
          {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
        </Button>
      </div>
      )}
    </Field>
  );
}
