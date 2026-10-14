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
}: ChatEmptyStateProps) {
  const { t } = useI18n();

  if (settingsReady && !hasApiKey) {
    return (
      <EmptyState variant="compact">
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
