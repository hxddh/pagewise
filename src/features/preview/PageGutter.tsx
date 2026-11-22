import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { useOptionalToast } from "../../hooks/useToast";
import type { AnswerNote, PageCitation } from "../../lib/page-citations";
import { columnEntries, columnTops, cardExcerpt, gutterEntries, type GutterEntry } from "./page-gutter";
import { getMarks, MAX_NOTE_TEXT, removeMark, setMarkNote, undoMarkChange, type Mark } from "../../lib/mark-store";
import { getFindings } from "../../lib/finding-store";
import { placeFinding } from "../../lib/finding-anchors";
import { cachedCitationCheck, checkCitation } from "../../lib/citation-check";
import { getPageGeometry, type PageGeometry } from "../../lib/pdf";
import { citationLabel } from "../../lib/remark-citations";
import { TRUST_TEXT, longKey, stateKey, type TrustReason } from "../../lib/trust-text";
import { pdfRectToBox, topLeftRectToBox } from "./search-highlight";
import { AnchoredMenu } from "../../components/AnchoredMenu";
import { ListRow } from "../../components/ui/ListRow";
import { TextArea } from "../../components/ui/Field";

/**
 * Where a page sits, as the scroller laid it out.
 *
 * Handed over rather than recomputed: `page-layout.ts` decides where a page is
 * and `PageScroller` is the only thing that knows how the column centres it, so
 * the margin reads those numbers instead of inventing a second coordinate
 * system beside them.
 */
export interface PageMarginBox {
  /** Scrolltop of the page's top edge. */
  top: number;
  /** CSS length for the page's outer (right) edge within the column. */
  left: string;
  /** Rendered height of the page; the strip never runs past it. */
  height: number;
  /** The margin the column reserves: how wide the strip is. */
  width: number;
}

interface PageGutterProps {
  path: string;
  /** 1-based. */
  page: number;
  box: PageMarginBox;
  /** Bumped when this document's marks or findings change. */
  revision: number;
  /**
   * True while the panel is closed and the margin is the column (20.0): the
   * entries carry their words instead of being dots.
   */
  column: boolean;
  /** Answers citing each page, from the conversation — the dots' list. */
  citations?: Map<number, PageCitation[]> | null;
  /** Answers' sentences citing each page, with their states — the column's. */
  notes?: Map<number, AnswerNote[]> | null;
  /** For checking an answer's marker the panel has not mounted a chip for. */
  totalPages: number;
  /** Currently selected mark, to open its note popover beside its margin entry. */
  selectedMarkId?: string | null;
  /** Open document stamp, to surface when a mark predates a modified file. */
  currentStamp?: string;
  /** Dismiss the active mark note popover. */
  onCloseMark?: () => void;
  /** The reader picked a mark: jump to it and open its note. */
  onSelectMark?: (page: number, id: string) => void;
  /** The reader picked a finding: show it on its page. */
  onSelectFinding?: (id: string, page: number) => void;
  /** The reader picked an answer: bring the turn in front of them. */
  onRevealMessage?: (messageId: string) => void;
}

async function anchorFor(
  path: string,
  page: number,
  entry: GutterEntry,
  geometry: PageGeometry,
  totalPages: number,
): Promise<number | undefined> {
  if (entry.kind === "mark") {
    const mark = getMarks(path).find((m) => m.id === entry.id);
    const rect = mark?.rects[0];
    return rect ? topLeftRectToBox(rect, geometry).top : undefined;
  }
  if (entry.kind === "finding") {
    const finding = getFindings(path).find((f) => f.id === entry.id);
    if (!finding) return undefined;
    const placement = await placeFinding(path, finding);
    if (placement.status !== "located" && placement.status !== "mismatch") return undefined;
    if (placement.anchor.page !== page) return undefined;
    return pdfRectToBox(placement.anchor.bounds, geometry).top;
  }
  for (const citation of entry.citations ?? []) {
    if (!citation.pages.includes(page)) continue;
    const check = cachedCitationCheck(path, citation) ?? (await checkCitation(path, totalPages, citation));
    if (check.status === "located" && check.page === page && check.rects?.length) {
      return pdfRectToBox(check.rects[0]!, geometry).top;
    }
  }
  return undefined;
}

interface ColumnPlacement {
  tops: number[];
  anchors: Array<number | undefined>;
}

const COLUMN_TIE_MIN = 0.005;
const MAX_TIE_LANES = 3;

function MarkNotePopoverBody({
  path,
  mark,
  currentStamp,
  onClose,
}: {
  path: string;
  mark: Mark;
  currentStamp: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const toast = useOptionalToast();
  const [note, setNote] = useState(mark.note);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(note);
  latest.current = note;

  useEffect(() => {
    setNote(mark.note);
  }, [mark.id, mark.note]);

  useEffect(() => {
    const id = mark.id;
    return () => {
      setMarkNote(path, id, latest.current);
    };
  }, [path, mark.id]);

  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [mark.id]);

  return (
    <>
      <div className="cite-popover-body">
        <p className="cite-popover-page">{t("marks.onPage", { page: mark.page })}</p>
        {mark.text && (
          <blockquote className="cite-popover-quote gutter-popover-quote-mark">{mark.text}</blockquote>
        )}
        {currentStamp && mark.stamp && mark.stamp !== currentStamp && (
          <p className="mark-stale-note">{t("marks.staleMark")}</p>
        )}
        <TextArea
          ref={textareaRef}
          className="gutter-mark-input"
          value={note}
          maxLength={MAX_NOTE_TEXT}
          placeholder={t("marks.notePlaceholder")}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => setMarkNote(path, mark.id, latest.current)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Escape") {
              e.stopPropagation();
              setMarkNote(path, mark.id, latest.current);
              onClose();
            }
          }}
        />
      </div>
      <div className="cite-popover-actions">
        <ListRow
          className="danger"
          label={t("marks.delete")}
          onClick={() => {
            removeMark(path, mark.id);
            toast?.showToast(t("toast.markDeleted"), "default", {
              label: t("toast.undoAction"),
              onClick: () => {
                undoMarkChange(path);
              },
            });
            onClose();
          }}
        />
      </div>
    </>
  );
}

export const PageGutter = memo(function PageGutter({
  path,
  page,
  box,
  revision,
  column,
  citations,
  notes,
  totalPages,
  selectedMarkId = null,
  currentStamp = "",
  onCloseMark,
  onSelectMark,
  onSelectFinding,
  onRevealMessage,
}: PageGutterProps) {
  const { t, locale } = useI18n();
  const listSep = locale === "zh-CN" ? "、" : ", ";
  const gutterRef = useRef<HTMLDivElement>(null);
  const entryRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const activeAnchorRef = useRef<HTMLElement | null>(null);
  const [expandedAnswerIdx, setExpandedAnswerIdx] = useState<number | null>(null);
  const answerAnchorRef = useRef<HTMLElement | null>(null);

  const entries = useMemo(
    () =>
      column
        ? columnEntries(path, page, notes)
        : gutterEntries(path, page, citations),
    [column, path, page, revision, citations, notes],
  );

  const selectedMark = useMemo(() => {
    void revision;
    if (!selectedMarkId) return null;
    const found = getMarks(path).find((m) => m.id === selectedMarkId);
    return found && found.page === page ? found : null;
  }, [path, page, revision, selectedMarkId]);

  useEffect(() => {
    if (!column) setExpandedAnswerIdx(null);
  }, [column, path, page]);

  const [placement, setPlacement] = useState<ColumnPlacement>({ tops: [], anchors: [] });
  useEffect(() => {
    if (!column || entries.length === 0) {
      setPlacement({ tops: [], anchors: [] });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const geometry = await getPageGeometry(path, page);
        const anchors: Array<number | undefined> = [];
        for (const entry of entries) {
          anchors.push(await anchorFor(path, page, entry, geometry, totalPages));
          if (cancelled) return;
        }
        if (!cancelled) setPlacement({ tops: columnTops(anchors), anchors });
      } catch {
        if (!cancelled) setPlacement({ tops: [], anchors: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [column, path, page, totalPages, entries]);

  const tieLanes = useMemo(() => {
    const lanes = new Map<number, number>();
    placement.tops
      .map((top, i) => ({ top, anchor: placement.anchors[i], i }))
      .filter((tie): tie is { top: number; anchor: number; i: number } =>
        tie.anchor !== undefined && Math.abs(tie.top - tie.anchor) > COLUMN_TIE_MIN,
      )
      .sort((a, b) => a.anchor - b.anchor || a.i - b.i)
      .forEach((tie, rank) => lanes.set(tie.i, Math.min(rank, MAX_TIE_LANES - 1)));
    return lanes;
  }, [placement]);

  if (entries.length === 0 && !selectedMark) return null;

  if (selectedMark) {
    activeAnchorRef.current =
      entryRefs.current.get(`mark-${selectedMark.id}`) ?? gutterRef.current;
  }

  const expandedEntry =
    expandedAnswerIdx !== null && entries[expandedAnswerIdx]?.kind === "answer"
      ? entries[expandedAnswerIdx]!
      : null;

  const note = (entry: GutterEntry): string => {
    switch (entry.kind) {
      case "mark":
        return entry.note;
      case "finding":
        return entry.note;
      case "answer":
        return entry.note || t("gutter.answerCites", { page: entry.page });
    }
  };

  const label = (entry: GutterEntry): string => {
    switch (entry.kind) {
      case "mark":
        return entry.fromNote
          ? t("marks.markWithNote", { note: entry.note })
          : t("marks.markPlain", { text: entry.note.slice(0, 80) });
      case "finding":
        return t("record.onPage", { claim: entry.note });
      case "answer":
        return t("gutter.answerCites", { page: entry.page });
    }
  };

  const activate = (entry: GutterEntry, index: number, targetEl: HTMLButtonElement) => {
    if (entry.kind === "mark") {
      if (selectedMarkId === entry.id) onCloseMark?.();
      else onSelectMark?.(entry.page, entry.id);
      return;
    }
    if (entry.kind === "finding") {
      onSelectFinding?.(entry.id, entry.page);
      return;
    }
    if (column) {
      answerAnchorRef.current = targetEl;
      setExpandedAnswerIdx((prev) => (prev === index ? null : index));
      return;
    }
    onRevealMessage?.(entry.id);
  };

  const bindEntryRef = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) entryRefs.current.set(key, el);
    else entryRefs.current.delete(key);
  };

  const markPopover = selectedMark ? (
    <AnchoredMenu
      open={true}
      onClose={() => onCloseMark?.()}
      anchorRef={activeAnchorRef}
      className="anchored-popover cite-popover"
      align="end"
      role="dialog"
    >
      <MarkNotePopoverBody
        path={path}
        mark={selectedMark}
        currentStamp={currentStamp}
        onClose={() => onCloseMark?.()}
      />
    </AnchoredMenu>
  ) : null;

  if (!column) {
    return (
      <div
        ref={gutterRef}
        className="page-gutter"
        role="group"
        aria-label={t("gutter.label")}
        data-page={page}
        style={{ top: box.top, left: box.left, maxHeight: box.height }}
      >
        {entries.map((entry, i) => (
          // raw-button: an 8px dot in the page margin — it has no box the shared
          // button styles could give it, and the group above is its label.
          <button
            key={`${entry.kind}-${entry.id}`}
            ref={bindEntryRef(`${entry.kind}-${entry.id}`)}
            type="button"
            className={`gutter-dot gutter-dot-${entry.kind}`}
            data-gutter-kind={entry.kind}
            title={note(entry)}
            aria-label={label(entry)}
            onClick={(e) => activate(entry, i, e.currentTarget)}
          />
        ))}
        {markPopover}
      </div>
    );
  }

  const expandedReason = expandedEntry?.reason as TrustReason | undefined;
  const expandedPages = (expandedEntry?.citations ?? [])
    .map((c) => citationLabel(c.pages))
    .join(", ");
  const expandedVerdict = expandedReason
    ? t(longKey(expandedReason), {
        page: String(expandedEntry!.page),
        pages: expandedPages || String(expandedEntry!.page),
        numbers: (expandedEntry?.unstated ?? []).join(listSep),
      })
    : null;
  const expandedQuote = expandedEntry?.citations?.find((c) => c.quote)?.quote ?? null;

  return (
    <div
      ref={gutterRef}
      className="page-gutter page-gutter-column"
      role="group"
      aria-label={t("gutter.label")}
      data-page={page}
      style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
    >
      {entries.map((entry, i) => {
        const reason = entry.reason as TrustReason | undefined;
        const level = reason ? TRUST_TEXT[reason].level : "none";
        const pages = (entry.citations ?? [])
          .map((c) => citationLabel(c.pages))
          .join(", ");
        const title = reason
          ? `${entry.text}\n${t(longKey(reason), {
              page: String(entry.page),
              pages: pages || String(entry.page),
              numbers: (entry.unstated ?? []).join(listSep),
            })}`
          : note(entry);
        const top = placement.tops[i] ?? 0;
        let anchor = placement.anchors[i];
        const displacement = anchor !== undefined ? Math.abs(top - anchor) : 0;
        const tieSpan =
          anchor !== undefined && displacement > COLUMN_TIE_MIN
            ? { top: Math.min(anchor, top), height: displacement }
            : null;
        const tieLane = tieLanes.get(i);
        const tieUp = anchor !== undefined && top < anchor - COLUMN_TIE_MIN;
        const ink = `gutter-note-${entry.kind}${reason ? ` gutter-note-${level}` : ""}`;
        return (
          <Fragment key={`${entry.kind}-${entry.id}-${i}`}>
            {tieSpan !== null && (
              <span
                className={`gutter-note-leader${tieUp ? " gutter-note-leader-up" : ""} ${ink}`}
                aria-hidden
                data-tie-lane={tieLane ?? 0}
                style={{ top: `${tieSpan.top * 100}%`, height: `${tieSpan.height * 100}%` }}
              />
            )}
            {/* raw-button: a card in the page margin, not a control with a box
                of its own — the strip is its frame and the group above is its
                label. */}
            <button
              ref={bindEntryRef(`${entry.kind}-${entry.id}`)}
              type="button"
              className={`gutter-note ${ink}`}
              data-gutter-kind={entry.kind}
              data-gutter-state={entry.state}
              aria-expanded={entry.kind === "answer" ? expandedAnswerIdx === i : undefined}
              style={{ top: `${top * 100}%` }}
              title={title}
              aria-label={entry.kind === "answer" ? title : label(entry)}
              onClick={(e) => activate(entry, i, e.currentTarget)}
            >
              <span className="gutter-note-text">{cardExcerpt(entry.text)}</span>
              {entry.state && (
                <span className="gutter-note-state">{t(stateKey(entry.state, reason))}</span>
              )}
            </button>
          </Fragment>
        );
      })}
      {markPopover}
      {expandedEntry && (
        <AnchoredMenu
          open={true}
          onClose={() => setExpandedAnswerIdx(null)}
          anchorRef={answerAnchorRef}
          className="anchored-popover cite-popover"
          align="end"
          role="dialog"
        >
          <div className="cite-popover-body" aria-label={t("gutter.label")}>
            <p
              className={`gutter-popover-lead gutter-popover-${
                expandedReason ? TRUST_TEXT[expandedReason].level : "none"
              }`}
            >
              {expandedEntry.text}
            </p>
            {expandedVerdict && <p className="cite-popover-review">{expandedVerdict}</p>}
            {expandedQuote && (
              <blockquote
                className={`cite-popover-quote gutter-popover-quote-${
                  expandedReason ? TRUST_TEXT[expandedReason].level : "none"
                }`}
              >
                “{expandedQuote}”
              </blockquote>
            )}
          </div>
          {onRevealMessage && (
            <div className="cite-popover-actions">
              <ListRow
                label={t("gutter.openInChat")}
                onClick={() => {
                  const msgId = expandedEntry.id;
                  setExpandedAnswerIdx(null);
                  onRevealMessage(msgId);
                }}
              />
            </div>
          )}
        </AnchoredMenu>
      )}
    </div>
  );
});
