import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { Button } from "./ui/Button";
import { ListRow } from "./ui/ListRow";

/**
 * What a place says when it has nothing to show.
 *
 * Nine of these existed in eight files — the library's recents, the record's
 * empty list and its no-match line, the outline's, the palette's, two in the
 * document search, a reply that produced no text, and the chat panel's own four
 * branches. Only one was shared, and the eight were not variants of anything:
 * they were eight answers to the same question, each written next to the thing
 * that needed it.
 *
 * The shapes that differ are three, and they differ because the *place* does:
 *
 *   compact — a line or two at the top of a panel that is otherwise empty
 *             (no key yet, no document open, a model that cannot call tools).
 *   minimal — the invitation to start: suggestions against the composer, where
 *             the first message will arrive.
 *   inline  — one quiet line inside a list that already exists (no matches, no
 *             marks yet). The list's own margins and type stay its own, so this
 *             variant adds no class of its own.
 */
type EmptyStateVariant = "compact" | "minimal" | "inline";

interface EmptyStateProps {
  variant?: EmptyStateVariant;
  /** The state's copy, in order. */
  children?: ReactNode;
  /** The host's own class — placement and type are the host's business. */
  className?: string;
  /**
   * `polite` where the state arrives as the result of something the reader did
   * (a search that found nothing); omitted where it was there all along.
   */
  live?: "polite" | "assertive";
}

export function EmptyState({
  variant = "compact",
  children,
  className = "",
  live,
}: EmptyStateProps) {
  const classes = [
    variant === "inline" ? "" : "empty-state",
    variant === "inline" ? "" : `empty-state-${variant}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} aria-live={live}>
      {children}
    </div>
  );
}

interface ChatEmptyStateProps {
  hasApiKey: boolean;
  agentToolsSupported?: boolean;
  settingsReady: boolean;
  hasDocument: boolean;
  totalPages?: number;
  /** The page the reader is on, so the first suggestion can be about it. */
  previewPage?: number;
  onConfigureApi: () => void;
  onExamplePrompt?: (text: string) => void;
  /**
   * The reader asked something before any provider was connected, and it is
   * waiting in the composer to go out once one is (24.0).
   */
  questionQueued?: boolean;
}

/**
 * The chat panel's empty state: which of the three shapes above it gets, and
 * with which copy. This is the policy, not a second rendering — every branch
 * below returns the same `EmptyState`.
 */
export function ChatEmptyState({
  hasApiKey,
  agentToolsSupported = true,
  settingsReady,
  hasDocument,
  totalPages,
  previewPage,
  onConfigureApi,
  onExamplePrompt,
  questionQueued = false,
}: ChatEmptyStateProps) {
  const { t } = useI18n();

  // A document open and no provider (24.0). This was one grey line, while the
  // composer below looked ready and Enter only opened Settings; DeepSeek was
  // preselected there and nothing said page text would leave the machine. A
  // reader deciding whether to connect anything needs three facts here: what
  // already works without AI, the one control that connects it, and what will
  // be sent once it does. The composer's own "Configure AI" button is gone, so
  // this is the single control for it, not a second one.
  if (settingsReady && !hasApiKey && hasDocument) {
    return (
      <EmptyState variant="compact" className="empty-connect">
        <p className="empty-lead">{t("empty.connectLead")}</p>
        <p className="empty-connect-note">{t("empty.worksWithoutAi")}</p>
        <Button variant="primary" size="md" className="empty-connect-btn" onClick={onConfigureApi}>
          {t("empty.connectAi")}
        </Button>
        <p className="empty-connect-note">{t("empty.whatIsSent")}</p>
        {questionQueued && (
          <p className="empty-connect-queued" role="status">
            {t("empty.questionQueued")}
          </p>
        )}
      </EmptyState>
    );
  }

  if (settingsReady && !hasApiKey) {
    return (
      <EmptyState variant="compact">
        <p className="empty-lead">{t("empty.agentLead")}</p>
        <Button variant="link" size="md" onClick={onConfigureApi}>
          {t("empty.configureInline")}
        </Button>
      </EmptyState>
    );
  }

  if (settingsReady && hasApiKey && !agentToolsSupported) {
    return (
      <EmptyState variant="compact">
        <p className="empty-lead">{t("empty.agentToolsLead")}</p>
        <Button variant="link" size="md" onClick={onConfigureApi}>
          {t("empty.configureInline")}
        </Button>
      </EmptyState>
    );
  }

  if (!hasDocument) {
    return (
      <EmptyState variant="compact">
        <p className="empty-lead">{t("empty.waitingDoc")}</p>
      </EmptyState>
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
    <EmptyState variant="minimal">
      {onExamplePrompt && (
        <div className="empty-examples">
          {examples.map((example) => (
            <ListRow
              key={example}
              className="empty-example-chip"
              label={example}
              onClick={() => onExamplePrompt(example)}
            />
          ))}
        </div>
      )}
    </EmptyState>
  );
}
