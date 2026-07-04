import { useI18n } from "../i18n";

interface EmptyStateProps {
  hasApiKey: boolean;
  agentToolsSupported?: boolean;
  settingsReady: boolean;
  hasDocument: boolean;
  onConfigureApi: () => void;
  onExamplePrompt?: (text: string) => void;
}

export function EmptyState({
  hasApiKey,
  agentToolsSupported = true,
  settingsReady,
  hasDocument,
  onConfigureApi,
  onExamplePrompt,
}: EmptyStateProps) {
  const { t } = useI18n();

  if (settingsReady && !hasApiKey) {
    return (
      <div className="empty-state empty-state-compact">
        <p className="empty-lead">{t("empty.agentLead")}</p>
        <button type="button" className="link-btn" onClick={onConfigureApi}>
          {t("empty.configureInline")}
        </button>
      </div>
    );
  }

  if (settingsReady && hasApiKey && !agentToolsSupported) {
    return (
      <div className="empty-state empty-state-compact">
        <p className="empty-lead">{t("empty.agentToolsLead")}</p>
        <button type="button" className="link-btn" onClick={onConfigureApi}>
          {t("empty.configureInline")}
        </button>
      </div>
    );
  }

  if (!hasDocument) {
    return (
      <div className="empty-state empty-state-compact">
        <p className="empty-lead">{t("empty.waitingDoc")}</p>
      </div>
    );
  }

  return (
    <div className="empty-state empty-state-minimal">
      <p className="empty-lead">{t("empty.askLead")}</p>
      <p className="empty-hint">{t("empty.composerHint")}</p>
      {onExamplePrompt && (
        <div className="empty-examples">
          {[t("empty.example1"), t("empty.example2")].map((example) => (
            <button
              key={example}
              type="button"
              className="empty-example-chip"
              onClick={() => onExamplePrompt(example)}
            >
              {example}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
