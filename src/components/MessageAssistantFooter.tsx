import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { Copy, Gauge, RotateCcw } from "lucide-react";
import { AnchoredMenu } from "./AnchoredMenu";
import { useI18n } from "../i18n";
import {
  computeGenerationSpeed,
  computeTimeToFirstTokenMs,
  computeTotalDurationMs,
  formatDuration,
  formatGenerationSpeed,
  formatTokenCount,
  getPageWiseMetadata,
  type PageWiseUIMessage,
} from "../lib/message-metadata";

interface MessageAssistantFooterProps {
  message: PageWiseUIMessage;
  live?: boolean;
  canRegenerate?: boolean;
  onRegenerate?: () => void;
  onCopy?: () => void;
}

function extractCopyableText(message: UIMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.text?.trim()) parts.push(part.text);
    else if (part.type === "reasoning" && part.text?.trim()) parts.push(part.text);
  }
  return parts.join("\n\n").trim();
}

export function MessageAssistantFooter({
  message,
  live = false,
  canRegenerate = false,
  onRegenerate,
  onCopy,
}: MessageAssistantFooterProps) {
  const { t } = useI18n();
  const [statsOpen, setStatsOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const statsBtnRef = useRef<HTMLButtonElement>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);

  const metadata = getPageWiseMetadata(message);
  const showFooter = live || metadata?.startedAt != null;

  useEffect(() => {
    if (!live || metadata?.finishedAt != null) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [live, metadata?.finishedAt]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== undefined) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    const text = extractCopyableText(message);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      onCopy?.();
      if (copyTimerRef.current !== undefined) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }, [message, onCopy]);

  if (!showFooter) return null;

  const totalMs = metadata ? computeTotalDurationMs(metadata, nowMs) : undefined;
  const ttftMs = metadata ? computeTimeToFirstTokenMs(metadata) : undefined;
  const speed = metadata ? computeGenerationSpeed(metadata, nowMs) : undefined;
  const hasCopyable = extractCopyableText(message).length > 0;
  const agentIn =
    metadata?.inputTokens != null && metadata.indexInputTokens != null
      ? Math.max(0, metadata.inputTokens - metadata.indexInputTokens)
      : metadata?.inputTokens;
  const agentOut =
    metadata?.outputTokens != null && metadata.indexOutputTokens != null
      ? Math.max(0, metadata.outputTokens - metadata.indexOutputTokens)
      : metadata?.outputTokens;
  const citations = metadata?.structuredCitations ?? [];

  return (
    <div className="message-assistant-footer">
      {citations.length > 0 && (
        <ul className="structured-citations" aria-label={t("agent.structuredCitations")}>
          {citations.map((c, i) => (
            <li key={`${c.page}-${i}`}>
              <span className="structured-citation-page">
                p.
                {c.pageEnd && c.pageEnd !== c.page ? `${c.page}–${c.pageEnd}` : c.page}
              </span>
              <span className="structured-citation-quote">{c.quote}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="message-assistant-actions" role="toolbar" aria-label={t("agent.messageActions")}>
        <button
          type="button"
          className="icon-btn message-action-btn"
          onClick={() => void handleCopy()}
          disabled={!hasCopyable}
          title={copied ? t("agent.copied") : t("agent.copy")}
          aria-label={copied ? t("agent.copied") : t("agent.copy")}
        >
          <Copy size={14} />
        </button>
        {canRegenerate && onRegenerate && (
          <button
            type="button"
            className="icon-btn message-action-btn"
            onClick={onRegenerate}
            title={t("agent.regenerate")}
            aria-label={t("agent.regenerate")}
          >
            <RotateCcw size={14} />
          </button>
        )}
        <button
          ref={statsBtnRef}
          type="button"
          className={`icon-btn message-action-btn${statsOpen ? " active" : ""}`}
          onClick={() => setStatsOpen((o) => !o)}
          title={t("agent.usageStats")}
          aria-label={t("agent.usageStats")}
          aria-expanded={statsOpen}
        >
          <Gauge size={14} />
        </button>
      </div>

      <AnchoredMenu
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
        anchorRef={statsBtnRef}
        className="anchored-popover usage-stats-popover"
        align="start"
        role="menu"
      >
        <div className="usage-stats-panel" role="presentation">
          <dl className="usage-stats-list">
            <div className="usage-stats-row">
              <dt>{t("agent.usageTotalInput")}</dt>
              <dd>{formatTokenCount(metadata?.inputTokens)}</dd>
            </div>
            <div className="usage-stats-row">
              <dt>{t("agent.usageTotalOutput")}</dt>
              <dd>{formatTokenCount(metadata?.outputTokens)}</dd>
            </div>
            {(metadata?.indexInputTokens ?? 0) > 0 || (metadata?.indexOutputTokens ?? 0) > 0 ? (
              <>
                <div className="usage-stats-row usage-stats-sub">
                  <dt>{t("agent.usageAgentInput")}</dt>
                  <dd>{formatTokenCount(agentIn)}</dd>
                </div>
                <div className="usage-stats-row usage-stats-sub">
                  <dt>{t("agent.usageAgentOutput")}</dt>
                  <dd>{formatTokenCount(agentOut)}</dd>
                </div>
                <div className="usage-stats-row usage-stats-sub">
                  <dt>{t("agent.usageIndexInput")}</dt>
                  <dd>{formatTokenCount(metadata?.indexInputTokens)}</dd>
                </div>
                <div className="usage-stats-row usage-stats-sub">
                  <dt>{t("agent.usageIndexOutput")}</dt>
                  <dd>{formatTokenCount(metadata?.indexOutputTokens)}</dd>
                </div>
              </>
            ) : (metadata?.stepUsage?.length ?? 0) > 1 ? (
              <>
                <div className="usage-stats-row usage-stats-sub">
                  <dt>{t("agent.usageAgentInput")}</dt>
                  <dd>{formatTokenCount(agentIn)}</dd>
                </div>
                <div className="usage-stats-row usage-stats-sub">
                  <dt>{t("agent.usageAgentOutput")}</dt>
                  <dd>{formatTokenCount(agentOut)}</dd>
                </div>
              </>
            ) : null}
            <div className="usage-stats-row">
              <dt>{t("agent.usageTtft")}</dt>
              <dd>{formatDuration(ttftMs)}</dd>
            </div>
            <div className="usage-stats-row">
              <dt>{t("agent.usageTotalTime")}</dt>
              <dd>{formatDuration(totalMs)}</dd>
            </div>
            <div className="usage-stats-row">
              <dt>{t("agent.usageSpeed")}</dt>
              <dd>{formatGenerationSpeed(speed)}</dd>
            </div>
            {(metadata?.stepUsage?.length ?? 0) > 1 && (
              <>
                <div className="usage-stats-row usage-stats-section">
                  <dt>{t("agent.usageSteps")}</dt>
                  <dd />
                </div>
                {metadata!.stepUsage!.map((step) => (
                  <div key={step.step} className="usage-stats-row usage-stats-sub">
                    <dt>{t("agent.usageStep", { n: step.step + 1 })}</dt>
                    <dd>
                      {formatTokenCount(step.inputTokens)} / {formatTokenCount(step.outputTokens)}
                      {step.toolNames && step.toolNames.length > 0
                        ? ` · ${step.toolNames.join(", ")}`
                        : ""}
                    </dd>
                  </div>
                ))}
              </>
            )}
          </dl>
          {metadata?.includesToolContext && metadata.finishedAt != null && (
            <p className="usage-stats-footnote">{t("agent.usageToolContextNote")}</p>
          )}
          {metadata?.model && (
            <p className="usage-stats-model" title={metadata.model}>
              {metadata.model}
            </p>
          )}
        </div>
      </AnchoredMenu>
    </div>
  );
}
