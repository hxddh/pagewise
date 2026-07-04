import { useI18n } from "../../i18n";
import type { LlmSettings, ProviderId } from "../../lib/types";
import { isApiKeyConfigured } from "../../hooks/useConnectionStatus";

interface ConnectionChipProps {
  settings: LlmSettings;
  activeProvider: ProviderId;
  apiKeyTouched: boolean;
  apiKeyDraft: string;
  dirty: boolean;
}

export function ConnectionChip({
  settings,
  activeProvider,
  apiKeyTouched,
  apiKeyDraft,
  dirty,
}: ConnectionChipProps) {
  const { t } = useI18n();
  const isPreview = settings.provider !== activeProvider;

  if (dirty) {
    return (
      <span className="connection-chip connection-chip-unsaved" role="status">
        {t("settings.unsaved")}
      </span>
    );
  }

  if (isPreview) {
    return (
      <span className="connection-chip connection-chip-preview" role="status">
        {t("settings.previewMode")}
      </span>
    );
  }

  if (settings.connectionVerified) {
    return (
      <span className="connection-chip connection-chip-ok" role="status">
        {t("settings.connectionInUseVerified")}
      </span>
    );
  }

  if (isApiKeyConfigured(settings) || (apiKeyTouched && apiKeyDraft.trim())) {
    return (
      <span className="connection-chip connection-chip-ready" role="status">
        {t("settings.connectionReadyShort")}
      </span>
    );
  }

  return (
    <span className="connection-chip connection-chip-pending" role="status">
      {t("settings.connectionPendingShort")}
    </span>
  );
}
