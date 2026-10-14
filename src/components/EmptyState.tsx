import { useI18n } from "../i18n";
import { Button } from "./ui/Button";

interface EmptyStateProps {
  hasApiKey: boolean;
  agentToolsSupported?: boolean;
  settingsReady: boolean;
  hasDocument: boolean;
  totalPages?: number;
  /** The page the reader is on, so the first suggestion can be about it. */
  previewPage?: number;
  onConfigureApi: () => void;
  onExamplePrompt?: (text: string) => void;
}

export function EmptyState({
  hasApiKey,
  agentToolsSupported = true,
  settingsReady,
  hasDocument,
  totalPages,
  previewPage,
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

  // Three suggestions, no heading (16.0). "Ready to ask / type below or pick a
  // suggestion" described the panel to the reader instead of letting them
  // start; five examples, two of them the same summary, were a menu to read.
  //
  // The first one is about the page in view (17.0): a reader who has turned to
  // page 9 and opened the panel is asking about page 9, and the most useful
  // first chip is that question spelled out, not a generic one about the whole
  // document. It falls back to the document-level suggestion without a page.
  const examples = [
    previewPage && previewPage > 0
      ? t("empty.exampleThisPage", { page: previewPage })
      : totalPages && totalPages > 1
        ? t("empty.exampleWholeDoc", { count: totalPages })
        : t("empty.example1"),
    t("empty.example3"),
    t("empty.example2"),
  ];
  return (
    <div className="empty-state empty-state-minimal">
      {onExamplePrompt && (
        <div className="empty-examples">
          {examples.map((example) => (
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
