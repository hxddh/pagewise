import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { Copy, Gauge, RotateCcw, BookmarkPlus, BookmarkCheck, Sheet, ScanSearch } from "lucide-react";
import { cachedCitationCheck, withClaim } from "../lib/citation-check";
import { claimBefore } from "../lib/answer-tables";
import { extractCitations } from "../lib/citations";
import { cachedReview, reviewClaim } from "../lib/claim-review";
import { CitationContext } from "./CitationChip";
import {
  checkAnswer,
  tallyCitations,
  verifiedSentences,
  type CitationTally,
  type VerifiedSentence,
} from "../lib/citation-check";
import { AnchoredMenu } from "./AnchoredMenu";
import { useI18n } from "../i18n";
import { collectReadPages } from "../lib/read-pages";
import { claimFromAnswer } from "../lib/keep-answer";
import { citationsToText, stripCitations } from "../lib/citations";
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
import { Button } from "./ui/Button";
import { hasAnswerTable, tablesToCsv, type CsvLabels } from "../lib/answer-tables";
import { saveTextFile } from "../lib/save-markdown";

interface MessageAssistantFooterProps {
  message: PageWiseUIMessage;
  live?: boolean;
  canRegenerate?: boolean;
  onRegenerate?: () => void;
  onCopy?: () => void;
  /**
   * Keep this answer in the record. Absent when there is no document open.
   *
   * The claim is the one-line summary; `body` is the whole answer as it was
   * written, and `messageId` is where it came from. Until 12.0 only the
   * claim was kept.
   */
  onKeep?: (claim: string, pages: number[], source: { body: string; messageId: string }) => void;
  /**
   * Keep only the sentences whose citations were found on their pages, each as
   * its own record entry with the words that confirm it. Since 13.0.
   */
  onKeepVerified?: (sentences: VerifiedSentence[], messageId: string) => void;
}

/**
 * Put text on the clipboard, however this webview allows it.
 *
 * `navigator.clipboard` needs a secure context and is not present in every
 * webview a desktop build runs in; when it is missing the async call throws and
 * the button looks like it did nothing. The selection-based path is the older
 * mechanism every engine still implements.
 */
async function writeToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    const ok = document.execCommand?.("copy");
    if (!ok) throw new Error("clipboard unavailable");
  } finally {
    area.remove();
  }
}

/**
 * `markers` decides what becomes of an answer's citation markers: spelled out
 * for the clipboard, where the quote is the only way back to the passage;
 * dropped for a one-line claim, where they are noise.
 */
function extractCopyableText(message: UIMessage, markers: (text: string) => string = citationsToText): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.text?.trim()) {
      parts.push(markers(stripDsmlToolMarkup(part.text)));
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
  onKeep,
  onKeepVerified,
}: MessageAssistantFooterProps) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [statsOpen, setStatsOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  // Kept once. The record is append-and-revise, so a second click would write a
  // duplicate rather than update the first — and the reader has no way to see
  // that from here.
  const [kept, setKept] = useState(false);
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
      await writeToClipboard(text);
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
  const claimText = useMemo(() => extractCopyableText(message, stripCitations), [message]);
  // The answer as written — markdown intact — for the record to keep whole.
  const markdownText = useMemo(
    () =>
      stripDsmlToolMarkup(
        message.parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n"),
      ).trim(),
    [message.parts],
  );
  // The anchor: the pages this answer actually read. Already computed for the
  // "Pages read" trail, so keeping an answer invents nothing.
  const keepPages = useMemo(() => collectReadPages(message.parts), [message.parts]);

  // What the answer's citations turned out to be, once it has finished
  // streaming. The chips check themselves; this waits on the same checks
  // (shared by `citation-check.ts`) to say it in one line.
  const citationEnv = useContext(CitationContext);
  const [tally, setTally] = useState<CitationTally | null>(null);
  const [keptVerified, setKeptVerified] = useState(false);
  useEffect(() => {
    if (!citationEnv || live || !markdownText) {
      setTally(null);
      return;
    }
    let alive = true;
    setTally(tallyCitations(citationEnv.path, markdownText));
    void checkAnswer(citationEnv.path, citationEnv.totalPages, markdownText).then(
      (t) => alive && setTally(t),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [citationEnv, live, markdownText]);
  const verified = useMemo(
    () => (citationEnv && tally && tally.located > 0 ? verifiedSentences(citationEnv.path, markdownText) : []),
    [citationEnv, tally, markdownText],
  );

  const hasTable = useMemo(() => !live && hasAnswerTable(markdownText), [live, markdownText]);
  const exportTable = useCallback(async () => {
    if (!citationEnv) return;
    // The citations are checked by now, or checking; wait so the CSV says
    // what was found rather than "pending".
    await checkAnswer(citationEnv.path, citationEnv.totalPages, markdownText).catch(() => undefined);
    const labels: CsvLabels = {
      sources: t("table.sources"),
      checked: t("table.checked"),
      status: {
        located: t("table.statusLocated"),
        unlocated: t("table.statusUnlocated"),
        unreadable: t("table.statusUnreadable"),
        unconfirmed: t("table.statusUnconfirmed"),
        mismatch: t("table.statusMismatch"),
        unchecked: t("table.statusUnchecked"),
        outOfRange: t("table.statusOutOfRange"),
        pending: t("table.statusPending"),
      },
      found: (located, total) => t("table.found", { located: String(located), total: String(total) }),
      none: t("table.noQuote"),
    };
    const csv = tablesToCsv(citationEnv.path, markdownText, labels);
    if (!csv) return;
    const base = (citationEnv.path.split(/[/\\]/).pop() ?? "table").replace(/\.[^.]+$/, "");
    try {
      if (await saveTextFile(csv, `${base}-table.csv`, "CSV", ["csv"])) showToast(t("toast.tableExported"), "success");
    } catch {
      showToast(t("toast.exportFailed"), "error");
    }
  }, [citationEnv, markdownText, showToast, t]);

  // Found citations the model can be asked about: located, or found with a
  // number the passage does not state (15.0). One billed call each.
  const reviewable = useMemo(() => {
    if (!citationEnv || !tally || live) return [];
    const seen = new Set<string>();
    return extractCitations(markdownText).flatMap((c) => {
      const claim = claimBefore(markdownText, c.index);
      const check = withClaim(cachedCitationCheck(citationEnv.path, c), claim, c.quote);
      if (!c.quote || !claim || !check?.page || (check.status !== "located" && check.status !== "mismatch")) return [];
      const k = `${claim}\n${c.quote}`;
      if (seen.has(k)) return [];
      seen.add(k);
      return [{ claim, quote: c.quote, passage: check.passage ?? c.quote, page: check.page }];
    });
  }, [citationEnv, tally, live, markdownText]);
  const [reviewing, setReviewing] = useState(false);
  const reviewCitations = useCallback(async () => {
    if (!citationEnv || reviewing) return;
    setReviewing(true);
    const counts = { supports: 0, contradicts: 0, insufficient: 0 };
    let failed = 0;
    for (const r of reviewable) {
      try {
        const verdict = await reviewClaim(citationEnv.path, r.claim, r.quote, r.passage, r.page);
        counts[verdict.verdict] += 1;
      } catch {
        failed += 1;
      }
    }
    setReviewing(false);
    if (failed === reviewable.length) {
      showToast(t("cite.reviewFailed"), "error");
      return;
    }
    showToast(
      t("cite.reviewDone", {
        supports: String(counts.supports),
        contradicts: String(counts.contradicts),
        insufficient: String(counts.insufficient),
      }),
      counts.contradicts > 0 ? "error" : "success",
    );
  }, [citationEnv, reviewing, reviewable, showToast, t]);
  const reviewedAll =
    reviewable.length > 0 && citationEnv
      ? reviewable.every((r) => cachedReview(citationEnv.path, r.claim, r.quote))
      : false;

  if (!showFooter) return null;

  const totalMs = metadata ? computeTotalDurationMs(metadata, nowMs) : undefined;
  const ttftMs = metadata ? computeTimeToFirstTokenMs(metadata) : undefined;
  const speed = metadata ? computeGenerationSpeed(metadata, nowMs) : undefined;
  const agentIn = resolveAgentTokenTotals(metadata).input;
  const agentOut = resolveAgentTokenTotals(metadata).output;

  return (
    <div className="message-assistant-footer">
      <div className="message-assistant-toolbar">
        <div className="message-assistant-actions" role="toolbar" aria-label={t("agent.messageActions")}>
        <Button
          variant="ghost" size="sm" icon className="message-action-btn"
          onClick={() => void handleCopy()}
          disabled={!hasCopyable}
          title={copied ? t("agent.copied") : t("agent.copy")}
          aria-label={copied ? t("agent.copied") : t("agent.copy")}
        >
          <Copy size={14} />
        </Button>
        {onKeep && keepPages.length > 0 && (
          <Button
            variant="ghost" size="sm" icon className="message-action-btn"
            onClick={() => {
              onKeep(claimFromAnswer(claimText), keepPages, {
                body: markdownText,
                messageId: message.id,
              });
              setKept(true);
            }}
            disabled={kept}
            title={kept ? t("record.kept") : t("record.keep")}
            aria-label={kept ? t("record.kept") : t("record.keep")}
          >
            <BookmarkPlus size={14} />
          </Button>
        )}
        {onKeepVerified && verified.length > 0 && (
          <Button
            variant="ghost" size="sm" icon className="message-action-btn"
            onClick={() => {
              onKeepVerified(verified, message.id);
              setKeptVerified(true);
            }}
            disabled={keptVerified}
            title={
              keptVerified
                ? t("cite.keptVerified", { count: String(verified.length) })
                : t("cite.keepVerified", { count: String(verified.length) })
            }
            aria-label={
              keptVerified
                ? t("cite.keptVerified", { count: String(verified.length) })
                : t("cite.keepVerified", { count: String(verified.length) })
            }
          >
            <BookmarkCheck size={14} />
          </Button>
        )}
        {citationEnv && reviewable.length > 0 && (
          <Button
            variant="ghost" size="sm" icon className="message-action-btn"
            onClick={() => void reviewCitations()}
            disabled={reviewing || reviewedAll}
            title={
              reviewedAll
                ? t("cite.reviewed")
                : t("cite.reviewAction", { count: String(reviewable.length) })
            }
            aria-label={
              reviewedAll
                ? t("cite.reviewed")
                : t("cite.reviewAction", { count: String(reviewable.length) })
            }
          >
            <ScanSearch size={14} />
          </Button>
        )}
        {citationEnv && hasTable && (
          <Button
            variant="ghost" size="sm" icon className="message-action-btn"
            onClick={() => void exportTable()}
            title={t("table.export")}
            aria-label={t("table.export")}
          >
            <Sheet size={14} />
          </Button>
        )}
        {canRegenerate && onRegenerate && (
          <Button
            variant="ghost" size="sm" icon className="message-action-btn"
            onClick={onRegenerate}
            title={t("agent.regenerate")}
            aria-label={t("agent.regenerate")}
          >
            <RotateCcw size={14} />
          </Button>
        )}
        <Button
          ref={statsBtnRef}
          variant="ghost"
          size="sm"
          icon
          className="message-action-btn"
          aria-pressed={statsOpen}
          onClick={() => setStatsOpen((o) => !o)}
          title={t("agent.usageStats")}
          aria-label={t("agent.usageStats")}
          aria-expanded={statsOpen}
        >
          <Gauge size={14} />
        </Button>
        </div>
        {tally && tally.total > 0 && (
          <p
            className={`citation-tally${tally.unlocated > 0 || tally.outOfRange > 0 || tally.mismatch > 0 ? " citation-tally-warn" : ""}`}
            aria-live="polite"
          >
            {t("cite.tally", { located: String(tally.located), total: String(tally.total) })}
            {tally.unlocated + tally.outOfRange > 0 &&
              ` · ${t("cite.tallyUnlocated", { count: String(tally.unlocated + tally.outOfRange) })}`}
            {tally.unreadable > 0 && ` · ${t("cite.tallyUnreadable", { count: String(tally.unreadable) })}`}
            {tally.mismatch > 0 && ` · ${t("cite.tallyMismatch", { count: String(tally.mismatch) })}`}
            {tally.unconfirmed > 0 &&
              ` · ${t("cite.tallyUnconfirmed", { count: String(tally.unconfirmed) })}`}
          </p>
        )}
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
            {(metadata?.cachedInputTokens ?? 0) > 0 && (
              // Shown because its absence was the problem: the prompt's cached
              // prefix used to be thrown away on nearly every turn and nothing
              // here could have told anyone.
              <div className="usage-stats-row usage-stats-sub">
                <dt title={t("agent.usageCachedHint")}>{t("agent.usageCached")}</dt>
                <dd>{formatTokenCount(metadata?.cachedInputTokens)}</dd>
              </div>
            )}
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
            {(metadata?.indexCalls ?? 0) > 0 && (
              <div className="usage-stats-row usage-stats-sub">
                <dt>{t("agent.usageScanCalls")}</dt>
                <dd>{metadata!.indexCalls}</dd>
              </div>
            )}
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
