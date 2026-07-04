import { useCallback, useEffect, useState } from "react";
import { loadSettings } from "../lib/settings";
import { isToolModel } from "../lib/model-capabilities";
import { useI18n } from "../i18n";
import { PROVIDER_PRESETS, type LlmSettings } from "../lib/types";

export function isApiKeyConfigured(settings: LlmSettings): boolean {
  if (settings.provider === "ollama") return true;
  return settings.apiKey.trim().length > 0;
}

export function useConnectionStatus() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<LlmSettings | null>(null);

  const refresh = useCallback(() => {
    loadSettings().then(setSettings);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const settingsReady = settings !== null;
  const hasApiKey = settings ? isApiKeyConfigured(settings) : false;
  const agentToolsSupported = settings
    ? isToolModel(settings.provider, settings.model)
    : true;
  const canUseAgent = hasApiKey && agentToolsSupported;
  const verified = settings?.connectionVerified === true;
  const providerLabel =
    settings && settings.provider !== "custom"
      ? PROVIDER_PRESETS[settings.provider].label
      : settings?.provider === "custom"
        ? t("settings.providerCustom")
        : null;

  return {
    canUseAgent,
    hasApiKey,
    agentToolsSupported,
    settingsReady,
    verified,
    providerLabel,
    model: settings?.model ?? null,
    refresh,
  };
}
