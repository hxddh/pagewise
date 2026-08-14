import { useI18n } from "../i18n";
import { Button } from "./ui/Button";

interface EmptyStateProps {
  hasApiKey: boolean;
  agentToolsSupported?: boolean;
  settingsReady: boolean;
  hasDocument: boolean;
  totalPages?: number;
  onConfigureApi: () => void;
  onExamplePrompt?: (text: string) => void;
}

export function EmptyState({
  hasApiKey,
  agentToolsSupported = true,
  settingsReady,
  hasDocument,
  totalPages,
  onConfigureApi,
  onExamplePrompt,
}: EmptyStateProps) {
  const { t } = useI18n();

  if (settingsReady && !hasApiKey) {
    return (
      <div className="empty-state empty-state-compact">
        <p className="empty-lead">{t("empty.agentLead")}</p>
        {/*
          With a document open the composer's own button becomes "Configure AI"
          (ChatPanel), so a link here put two controls for one action on screen
          at once — an explanation at the top of the panel and a primary button
          at the bottom of it. The message is worth keeping either way; the
          second control is not. Without a document the composer has no such
          button, so this is the only way through and it stays.
        */}
        {!hasDocument && (
          <Button variant="link" size="md" onClick={onConfigureApi}>
            {t("empty.configureInline")}
          </Button>
        )}
      </div>
    );
  }

  if (settingsReady && hasApiKey && !agentToolsSupported) {
    return (
      <div className="empty-state empty-state-compact">
        <p className="empty-lead">{t("empty.agentToolsLead")}</p>
        <Button variant="link" size="md" onClick={onConfigureApi}>
          {t("empty.configureInline")}
        </Button>
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
          {[
            totalPages && totalPages > 1
              ? t("empty.exampleWholeDoc", { count: totalPages })
              : null,
            t("empty.example1"),
            t("empty.example2"),
            t("empty.example3"),
            t("empty.example4"),
          ]
            .filter((e): e is string => !!e)
            .map((example) => (
              // raw-button: a text chip that reads as a suggestion, not as a control with a height
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
