import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { UIMessage } from "ai";
import { Copy, RotateCcw, BookmarkPlus, BookmarkCheck, MoreHorizontal } from "lucide-react";
import { cachedCitationCheck } from "../lib/citation-check";
import { claimBefore } from "../lib/answer-tables";
import { extractCitations } from "../lib/citations";
import { cachedReview, REVIEW_BATCH, reviewAll, reviewBasis, reviewRevision, subscribeReviews } from "../lib/claim-review";
import {
  SENTENCE_STATES,
  sentenceStates,
  sentenceTally,
  verifiedSentences,
  type VerifiedSentence,
} from "../lib/answer-sentences";
import { longKey, shortKey } from "../lib/trust-text";
import { CitationContext } from "./CitationChip";
import { checkAnswer, tallyCitations, type CitationTally } from "../lib/citation-check";
import { AnchoredMenu } from "./AnchoredMenu";
import { ListRow } from "./ui/ListRow";
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
  formatUsageSummaryLine,
  getPageWiseMetadata,
  resolveAgentTokenTotals,
  type PageWiseUIMessage,
} from "../lib/message-metadata";
import { loadPreferences } from "../lib/preferences";
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  // Kept once. The record is append-and-revise, so a second click would write a
  // duplicate rather than update the first — and the reader has no way to see
  // that from here.
  const [kept, setKept] = useState(false);
  const statsBtnRef = useRef<HTMLButtonElement>(null);
  const copyTimerRef = useRef<number | undefined>(undefined);
  // The usage line is a preference (`showUsageLine`, on by default): a reader
  // paying per question is entitled to the number, and off is for the reader who
  // finds it noise. Read once, like the other preference reads in the app.
  const [showUsageLine, setShowUsageLine] = useState(true);

  const metadata = getPageWiseMetadata(message);
  const showFooter = live || metadata?.startedAt != null;

  useEffect(() => {
    let alive = true;
    loadPreferences().then(
      (prefs) => {
        if (alive) setShowUsageLine(prefs.showUsageLine);
      },
      // A store that rejects leaves the default (on) in place rather than
      // turning the line off for everyone.
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

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

  // The line under a settled answer (18.0): pages · steps · tokens in/out ·
  // cache hits · scans, from what the message already records. Live answers have
  // no totals yet, so the line appears when the answer settles.
  const usageLine = useMemo(
    () => (live ? null : formatUsageSummaryLine(metadata, t, keepPages.length)),
    [live, metadata, t, keepPages.length],
  );

  // Every sentence of the answer, in the state its evidence put it in (20.0).
  // The chips check themselves as each marker closes, so this is computed —
  // and shown — while the answer streams: the counts land as the checks do,
  // instead of a line appearing only once the answer has settled.
  const citationEnv = useContext(CitationContext);
  const [tally, setTally] = useState<CitationTally | null>(null);
  const [keptVerified, setKeptVerified] = useState(false);
  useEffect(() => {
    if (!citationEnv || !markdownText) {
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
  }, [citationEnv, markdownText]);
  // Changes whenever a review lands, so a sentence a model contradicted stops
  // reading as verified.
  const reviewRev = useSyncExternalStore(subscribeReviews, reviewRevision);
  const sentences = useMemo(
    () => (citationEnv ? sentenceStates(citationEnv.path, markdownText) : null),
    // `tally` and `reviewRev` are what change when a check or a review lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [citationEnv, tally, reviewRev, markdownText],
  );
  const counts = useMemo(() => (sentences ? sentenceTally(sentences) : null), [sentences]);
  // Keep stays what it was: the verified sentences of a settled answer. A
  // half-written answer has no sentence set worth keeping — the record is
  // append-and-revise, so a partial keep cannot be corrected.
  const verified = useMemo(
    () => (!live && citationEnv && tally?.located ? verifiedSentences(citationEnv.path, markdownText) : []),
    [live, citationEnv, tally, markdownText],
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
      // What each check found, in the one table of those words (trust-text.ts).
      status: {
        located: t(shortKey("located")),
        unlocated: t(shortKey("unlocated")),
        unreadable: t(shortKey("unreadable")),
        unconfirmed: t(shortKey("unconfirmed")),
        mismatch: t(shortKey("mismatch")),
        unchecked: t(shortKey("unchecked")),
        tooShort: t(shortKey("tooShort")),
        outOfRange: t(shortKey("outOfRange")),
        pending: t(shortKey("pending")),
      },
      level: { verified: t("level.verified"), check: t("level.check"), notFound: t("level.notFound") },
      // The model's reading where the reader asked for one (20.0), labelled as
      // the model's — the same words the chip shows beside the local verdict.
      review: {
        supports: t("cite.review.supports"),
        contradicts: t("cite.review.contradicts"),
        insufficient: t("cite.review.insufficient"),
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

  // Citations the model can be asked about: found, or found with a number the
  // passage does not state (15.0) — and, since 22.0, not found on a page that
  // has text, read against that page: the next step for a red chip.
  // `REVIEW_BATCH` to a call (21.0).
  const reviewable = useMemo(() => {
    if (!citationEnv || !tally || live) return [];
    const seen = new Set<string>();
    return extractCitations(markdownText).flatMap((c) => {
      const claim = claimBefore(markdownText, c.index);
      const basis = reviewBasis(cachedCitationCheck(citationEnv.path, c));
      if (!c.quote || !claim || !basis) return [];
      const k = `${claim}\n${c.quote}\n${basis.page}`;
      if (seen.has(k)) return [];
      seen.add(k);
      return [{ claim, quote: c.quote, ...basis }];
    });
  }, [citationEnv, tally, live, markdownText]);
  const [reviewing, setReviewing] = useState(false);
  // Aborted when the document changes or the answer leaves the screen: a
  // review in progress then makes no further billed call (16.0, B12).
  const reviewAbort = useRef<AbortController | null>(null);
  const reviewPath = citationEnv?.path;
  useEffect(
    () => () => {
      reviewAbort.current?.abort();
      reviewAbort.current = null;
    },
    [reviewPath],
  );
  const reviewCitations = useCallback(async () => {
    if (!citationEnv || reviewing) return;
    const controller = new AbortController();
    reviewAbort.current = controller;
    setReviewing(true);
    const { counts, failed, cancelled } = await reviewAll(citationEnv.path, reviewable, controller.signal);
    setReviewing(false);
    if (cancelled) return;
    reviewAbort.current = null;
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
  // What the button would actually send: a citation already reviewed — this
  // session or, since 21.0, a previous one — is not asked about again.
  const reviewPending = citationEnv
    ? reviewable.filter((r) => !cachedReview(citationEnv.path, r.claim, r.quote, r)).length
    : 0;
  const reviewedAll = reviewable.length > 0 && reviewPending === 0;

  const keepWhole = () => {
    if (!onKeep) return;
    onKeep(claimFromAnswer(claimText), keepPages, { body: markdownText, messageId: message.id });
    setKept(true);
  };
  const keepAction =
    onKeepVerified && verified.length > 0
      ? {
          verified: true,
          done: keptVerified,
          label: keptVerified
            ? t("cite.keptVerified", { count: String(verified.length) })
            : t("cite.keepVerified", { count: String(verified.length) }),
          run: () => {
            onKeepVerified(verified, message.id);
            setKeptVerified(true);
          },
        }
      : onKeep && keepPages.length > 0
        ? { verified: false, done: kept, label: kept ? t("record.kept") : t("record.keep"), run: keepWhole }
        : null;

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
        {/* The two used most carry their word, not only an icon (16.0). */}
        <Button
          variant="ghost" size="sm" className="message-action-btn message-action-labelled"
          onClick={() => void handleCopy()}
          disabled={!hasCopyable}
          title={copied ? t("agent.copied") : t("agent.copy")}
          aria-label={copied ? t("agent.copied") : t("agent.copy")}
        >
          <Copy size={14} aria-hidden />
          {copied ? t("agent.copied") : t("agent.copy")}
        </Button>
        {/* Keep: the verified sentences when there are some — the record is
            for what holds — else the whole answer. The other is in More (16.0). */}
        {keepAction && (
          <Button
            variant="ghost" size="sm" className="message-action-btn message-action-labelled"
            onClick={keepAction.run}
            disabled={keepAction.done}
            title={keepAction.label}
            aria-label={keepAction.label}
          >
            {keepAction.verified ? <BookmarkCheck size={14} aria-hidden /> : <BookmarkPlus size={14} aria-hidden />}
            {keepAction.done ? t("record.keptShort") : t("record.keepShort")}
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
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((o) => !o)}
          title={t("agent.moreActions")}
          aria-label={t("agent.moreActions")}
        >
          <MoreHorizontal size={14} />
        </Button>
        </div>
        {counts && counts.total > 0 && (
          <p className="citation-tally" aria-live="polite">
            {SENTENCE_STATES.filter((state) => counts[state] > 0).map((state, i) => (
              <span
                key={state}
                className={`citation-tally-${state}`}
                // What the state means, from the one table of those words —
                // "nothing says where this sentence came from", for the class
                // that had no word before 20.0.
                title={state === "unchecked" ? t(longKey("noMarker")) : undefined}
              >
                {i > 0 ? " · " : ""}
                {t(`cite.tallyLevel.${state}`, { count: String(counts[state]) })}
              </span>
            ))}
            {counts.pending > 0 && (
              <span className="citation-tally-checking">
                {counts.total - counts.pending > 0 ? " · " : ""}
                {t("cite.tallyChecking", { count: String(counts.pending) })}
              </span>
            )}
          </p>
        )}
        {/* What this answer cost, from the metadata the popover below shows in
            full. Settled answers only — a live one has no totals yet. */}
        {usageLine && showUsageLine && (
          <p className="message-usage-line">{usageLine}</p>
        )}
      </div>

      <AnchoredMenu
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        anchorRef={statsBtnRef}
        className="anchored-popover"
        align="start"
      >
        {keepAction?.verified && onKeep && keepPages.length > 0 && (
          <ListRow
            role="menuitem"
            disabled={kept}
            label={kept ? t("record.kept") : t("record.keepWhole")}
            onClick={() => { setMoreOpen(false); keepWhole(); }}
          />
        )}
        {citationEnv && hasTable && (
          <ListRow
            role="menuitem"
            label={t("table.export")}
            onClick={() => { setMoreOpen(false); void exportTable(); }}
          />
        )}
        {citationEnv && reviewable.length > 0 && (
          <ListRow
            role="menuitem"
            disabled={reviewing || reviewedAll}
            label={
              reviewedAll
                ? t("cite.reviewed")
                : t("cite.reviewAction", {
                    count: String(reviewable.length),
                    calls: String(Math.ceil(reviewPending / REVIEW_BATCH)),
                  })
            }
            onClick={() => { setMoreOpen(false); void reviewCitations(); }}
          />
        )}
        <ListRow
          role="menuitem"
          label={t("agent.usageStats")}
          onClick={() => { setMoreOpen(false); setStatsOpen(true); }}
        />
      </AnchoredMenu>

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
