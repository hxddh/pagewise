import { useI18n } from "../../i18n";
import type { LlmSettings, ProviderId } from "../../lib/types";
import { isApiKeyConfigured } from "../../hooks/useConnectionStatus";

interface ConnectionChipProps {
  settings: LlmSettings;
  activeProvider: ProviderId;
  apiKeyTouched: boolean;
  apiKeyDraft: string;
  dirty: boolean;
  /** The last connection test failed and its error is still on the panel. */
  testFailed?: boolean;
}

export function ConnectionChip({
  settings,
  activeProvider,
  apiKeyTouched,
  apiKeyDraft,
  dirty,
  testFailed = false,
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

  // Ahead of `connectionVerified`, which records that some earlier test passed.
  // A key that has since been revoked leaves that flag set, so the panel showed
  // "Invalid API key — check Settings → AI Provider." in a red banner with a
  // green "In use · verified" badge two inches above it, both true to their own
  // source and flatly contradicting each other on screen.
  //
  // Only the badge changes. `connectionVerified` still gates the agent, and a
  // failed test can be a dropped network rather than a bad key — clearing it
  // here would lock a reader out of chat over one timeout.
  if (testFailed) {
    return (
      <span className="connection-chip connection-chip-failed" role="status">
        {t("settings.testFailed")}
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
