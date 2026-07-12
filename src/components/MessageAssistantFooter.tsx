import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { Copy, Gauge, RotateCcw } from "lucide-react";
import { AnchoredMenu } from "./AnchoredMenu";
import { useI18n } from "../i18n";
import { useToast } from "../hooks/useToast";
import { stripDsmlToolMarkup } from "../lib/agent-loop-guards";
import {
  computeGenerationSpeed,
  computeTimeToFirstTokenMs,
  computeTotalDurationMs,
  formatDuration,
  formatGenerationSpeed,
  formatTokenCount,
  getPageWiseMetadata,
  resolveAgentTokenTotals,
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
    if (part.type === "text" && part.text?.trim()) {
      parts.push(stripDsmlToolMarkup(part.text));
    } else if (part.type === "reasoning" && part.text?.trim()) {
      parts.push(part.text);
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * Structural signature of everything this footer renders (id + parts shape +
 * the metadata fields it reads), used to skip re-renders driven by the parent
 * re-rendering on every streamed chunk.
 */
function footerSignature(message: PageWiseUIMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  let partsSig = `${parts.length}`;
  for (const p of parts) {
    if (p.type === "text" || p.type === "reasoning") {
      partsSig += `:${p.type}${p.text?.length ?? 0}`;
    } else {
      partsSig += `:${p.type}`;
    }
  }
  const meta = getPageWiseMetadata(message);
  const metaSig = meta ? JSON.stringify(meta) : "";
  return `${message.id}|${partsSig}|${metaSig}`;
}

function MessageAssistantFooterInner({
  message,
  live = false,
  canRegenerate = false,
  onRegenerate,
  onCopy,
}: MessageAssistantFooterProps) {
  const { t } = useI18n();
  const { showToast } = useToast();
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
      // Clipboard can be unavailable (permissions, insecure context). Surface it
      // instead of leaving the button looking like a silent no-op.
      showToast(t("toast.copyFailed"), "error");
    }
  }, [message, onCopy, showToast, t]);

  // Hooks must run unconditionally — keep this above the early return below.
  const hasCopyable = useMemo(() => extractCopyableText(message).length > 0, [message]);

  if (!showFooter) return null;

  const totalMs = metadata ? computeTotalDurationMs(metadata, nowMs) : undefined;
  const ttftMs = metadata ? computeTimeToFirstTokenMs(metadata) : undefined;
  const speed = metadata ? computeGenerationSpeed(metadata, nowMs) : undefined;
  const agentIn = resolveAgentTokenTotals(metadata).input;
  const agentOut = resolveAgentTokenTotals(metadata).output;
  const citations = metadata?.structuredCitations ?? [];
  const citationsError = metadata?.citationsError;

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
      {citations.length === 0 && citationsError && (
        <p className="structured-citations-error" role="note">
          {t("agent.citationsError")}
        </p>
      )}

      <div className="message-assistant-toolbar">
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
      </div>

      <AnchoredMenu
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
        anchorRef={statsBtnRef}
        className="anchored-popover usage-stats-popover"
        align="start"
        role="dialog"
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
            {(metadata?.finalStepTools?.length ?? 0) > 0 && (
              <div className="usage-stats-row usage-stats-sub">
                <dt>{t("agent.usageFinalTools")}</dt>
                <dd>{metadata!.finalStepTools!.join(", ")}</dd>
              </div>
            )}
            {metadata?.providerMetadata && Object.keys(metadata.providerMetadata).length > 0 && (
              <div className="usage-stats-row usage-stats-section">
                <dt>{t("agent.usageProviderMeta")}</dt>
                <dd className="usage-stats-provider-meta">
                  {JSON.stringify(metadata.providerMetadata, null, 0).slice(0, 240)}
                </dd>
              </div>
            )}
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

/**
 * Prior (finished) assistant footers otherwise re-render on every streamed word
 * of the in-flight reply because the parent re-renders. Skip unless something
 * this footer actually renders changed (its structural signature or `live` /
 * `canRegenerate`); the unstable `onRegenerate`/`onCopy` closures are ignored.
 */
export const MessageAssistantFooter = memo(
  MessageAssistantFooterInner,
  (prev, next) => {
    if (prev.live !== next.live) return false;
    if (prev.canRegenerate !== next.canRegenerate) return false;
    if (prev.message === next.message) return true;
    return footerSignature(prev.message) === footerSignature(next.message);
  },
);
