import { X } from "lucide-react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { StatusLine } from "../../components/ui/StatusLine";

export interface ChatNoticesProps {
  /** Pages that still have no text (each costs a scan). */
  unscanned: number;
  /** Prompt to scan those pages; omit to hide the offer entirely. */
  onScanAll?: () => void;
  scanDismissed: boolean;
  onDismissScan: () => void;
  error: Error | undefined;
  errorMessage?: string;
  onRetry: () => void;
  onDismissError: () => void;
  /** A run is going: the notices' actions stand down. */
  interactionBusy: boolean;
  /** There is an answer to retry. */
  canRetry: boolean;
}

/**
 * The two notices between the transcript and the composer: the scan offer
 * (the agent can tell pages are unscanned and the app can fix it, so the
 * remedy sits where the symptom shows) and a failed run with its Retry.
 */
export function ChatNotices({
  unscanned,
  onScanAll,
  scanDismissed,
  onDismissScan,
  error,
  errorMessage,
  onRetry,
  onDismissError,
  interactionBusy,
  canRetry,
}: ChatNoticesProps) {
  const { t } = useI18n();

  return (
    <>
      {onScanAll && unscanned > 0 && !scanDismissed && (
        <StatusLine
          role="inline"
          className="chat-error"
          message={t("agent.unscannedPages", { count: unscanned })}
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={onScanAll} disabled={interactionBusy}>
                {t("preview.scanAllAction")}
              </Button>
              <Button
                variant="ghost" size="md" icon
                onClick={onDismissScan}
                aria-label={t("agent.dismissScanHint")}
                title={t("agent.dismissScanHint")}
              >
                <X size={14} />
              </Button>
            </>
          }
        />
      )}

      {error && (
        <StatusLine
          role="inline"
          tone="error"
          className="chat-error"
          message={errorMessage ?? error.message}
          actions={
            <>
              <Button
                variant="secondary" size="sm"
                onClick={onRetry}
                disabled={interactionBusy || !canRetry}
              >
                {t("agent.retry")}
              </Button>
              <Button
                variant="ghost" size="md" icon
                onClick={onDismissError}
                aria-label={t("agent.dismissError")}
                title={t("agent.dismissError")}
              >
                <X size={14} />
              </Button>
            </>
          }
        />
      )}
    </>
  );
}
