import { memo, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Crosshair,
  MessageSquare,
  Pencil,
  Sparkles,
  Trash2,
  Undo2,
  User,
} from "lucide-react";
import { recordLevel } from "../lib/trust-level";
import { longKey } from "../lib/trust-text";
import { useI18n } from "../i18n";
import {
  confirmFinding,
  getFindings,
  setFindingClaim,
  setFindingStruck,
  type Finding,
} from "../lib/finding-store";
import { getMarks, marksAreStale, removeMark, type Mark } from "../lib/mark-store";
import { useFindingPlacement } from "../hooks/useFindingPlacement";
import { trustNeedsReader, trustOf, type Trust } from "../lib/finding-trust";
import { Button } from "./ui/Button";
import { EmptyState } from "./EmptyState";
import { Input } from "./ui/Field";
import { Markdown } from "./Markdown";

interface RecordPanelProps {
  path: string;
  /** Changes when this document's record does, so the list re-reads it. */
  revision: number;
  currentPage: number;
  /** Some entries were written against a different version of this file. */
  stale: boolean;
  /** The open file's stamp, so each entry can say whether it is one of those. */
  stamp?: string;
  totalPages?: number;
  onJumpToPage: (page: number) => void;
  /** Show this claim where it was found: turn there and light it up. */
  onRevealFinding?: (id: string, page: number) => void;
  /** Turn to this mark and open its note. */
  onSelectMark?: (page: number, id: string) => void;
  /** Show the answer an entry was kept from. */
  onRevealMessage?: (messageId: string) => void;
  /**
   * Whether that answer is still in the conversation. A cleared or pruned
   * chat has no answer to go back to, and a button that does nothing is
   * worse than none (16.0, B20).
   */
  hasMessage?: (messageId: string) => boolean;
}

/**
 * How a list entry arrives and leaves (19.0).
 *
 * `useReducedMotion` is read here rather than left to the stylesheet, because
 * motion runs in JavaScript and the global reduced-motion block cannot reach
 * it. With the reader asking for less, the entry has no arrival at all
 * (`initial: false`) and the duration is zero — which is what "instant" means
 * for this movement.
 */
function useEntryMotion(): {
  initial: HTMLMotionProps<"li">["initial"];
  exit: HTMLMotionProps<"li">["exit"];
  transition: HTMLMotionProps<"li">["transition"];
} {
  const reduced = useReducedMotion() === true;
  return useMemo(
    () =>
      reduced
        ? { initial: false, exit: undefined, transition: { duration: 0 } }
        : {
            initial: { opacity: 0, y: 4 },
            exit: { opacity: 0, y: -4 },
            transition: { duration: 0.16, ease: "easeOut" },
          },
    [reduced],
  );
}

/**
 * What is known about this document, at a width that can hold it.
 *
 * 9.0 put this in the page sidebar, next to marks. That column is 160px and
 * sized for a thumbnail of a page; a finding is prose, and its claims wrapped
 * to four or five lines there. It cannot be widened at a 900px window without
 * pushing the preview toolbar back into the overlap 8.1.6 fixed.
 *
 * So the record lives here instead, in the assistant column — 360px at its
 * narrowest, 480 at its widest. That is what "the primary surface, with the
 * transcript one tab away" meant in the 9.0 design; putting it in the sidebar
 * was the mistake, and this corrects it. Marks stay where the reader made
 * them, and the page sidebar goes back to being about the page.
 *
 * ONE TRUST LINE PER ENTRY, since 12.0. Before, an entry could be flagged by
 * a banner over the whole list (the file changed), by a warning under it (the
 * wording is not on the page), or by nothing at all, and the model was told
 * something else again. Now `trustOf` decides once, the line under each entry
 * says what it decided, and the same answer goes into the record note and the
 * exported brief. Where the reader can settle it — a page the app could not
 * read, a file that changed — the line carries the one control that does.
 */
export const RecordPanel = memo(function RecordPanel({
  path,
  revision,
  currentPage,
  stale,
  stamp = "",
  totalPages = 0,
  onJumpToPage,
  onRevealFinding,
  onSelectMark,
  onRevealMessage,
  hasMessage,
}: RecordPanelProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  const [thisPageOnly, setThisPageOnly] = useState(false);

  const { rows, total } = useMemo(() => {
    void revision;
    const all = getFindings(path);
    let shown = all;
    if (thisPageOnly) shown = shown.filter((f) => f.pages.includes(currentPage));
    const needle = filter.trim().normalize("NFC").toLowerCase();
    if (needle) {
      shown = shown.filter((f) =>
        `${f.claim}\n${f.evidence}\n${f.why ?? ""}\n${f.body ?? ""}`
          .normalize("NFC")
          .toLowerCase()
          .includes(needle),
      );
    }
    return { rows: shown, total: all.length };
  }, [path, revision, filter, thisPageOnly, currentPage]);

  const all = useMemo(() => {
    void revision;
    return getFindings(path);
  }, [path, revision]);

  // The reader's own ink, kept beside the assistant's conclusions: this panel is
  // the document's ledger, and since 19.0 it is the one home for "everything I
  // kept on this document". Marks left the page sidebar's tab for the page
  // margin; the list that holds all of them belongs here, where a finding's
  // list already lives.
  const marks = useMemo(() => (void revision, getMarks(path)), [path, revision]);

  return (
    <div className="record-panel">
      {total === 0 ? (
        <EmptyState variant="inline" className="record-empty">
          <p>{t("record.empty")}</p>
          <p className="record-empty-hint">{t("record.emptyHint")}</p>
        </EmptyState>
      ) : (
        <>
          <div className="record-controls">
            <Input
              type="search"
              size="sm"
              className="record-filter"
              value={filter}
              placeholder={t("record.filterPlaceholder")}
              aria-label={t("record.filterPlaceholder")}
              onChange={(e) => setFilter(e.target.value)}
            />
            <Button
              variant={thisPageOnly ? "secondary" : "ghost"}
              size="sm"
              className="record-page-toggle"
              aria-pressed={thisPageOnly}
              onClick={() => setThisPageOnly((v) => !v)}
            >
              {t("record.thisPage", { page: currentPage })}
            </Button>
          </div>
          {stale && <p className="mark-stale-note">{t("record.staleFile")}</p>}
          {rows.length === 0 ? (
            <EmptyState variant="inline" className="record-none">{t("record.noMatch")}</EmptyState>
          ) : (
            <ul className="record-list">
              {/* The list's own movement: an entry arrives by fading up, and
                  leaves the same way — the reader sees what changed rather
                  than finding the list rearranged. */}
              <AnimatePresence initial={false}>
                {rows.map((finding) => (
                  <RecordEntry
                    key={finding.id}
                    path={path}
                    finding={finding}
                    all={all}
                    stamp={stamp}
                    totalPages={totalPages}
                    currentPage={currentPage}
                    onJumpToPage={onJumpToPage}
                    onRevealFinding={onRevealFinding}
                    onRevealMessage={onRevealMessage}
                    hasMessage={hasMessage}
                  />
                ))}
              </AnimatePresence>
            </ul>
          )}
        </>
      )}

      {marks.length > 0 && (
        <MarksSection
          path={path}
          marks={marks}
          stamp={stamp}
          currentPage={currentPage}
          onSelectMark={onSelectMark}
          onJumpToPage={onJumpToPage}
        />
      )}
    </div>
  );
});

/**
 * The reader's marks, as the document's other half of its ledger.
 *
 * One row per mark: what it says (or the note, which is what a region mark
 * often has), the page, and Delete. Jumping to a mark turns to its page and
 * opens the note card, which is where it can be written on — the same two
 * actions the mark's own row in the page sidebar had, and the reason they were
 * worth keeping when the sidebar tab went.
 */
function MarksSection({
  path,
  marks,
  stamp,
  currentPage,
  onSelectMark,
  onJumpToPage,
}: {
  path: string;
  marks: readonly Mark[];
  stamp: string;
  currentPage: number;
  onSelectMark?: (page: number, id: string) => void;
  onJumpToPage: (page: number) => void;
}) {
  const { t } = useI18n();
  const entryMotion = useEntryMotion();
  // Marks made against a different version of this file. Unlike the page index,
  // which is discarded when the file changes because it can be recomputed, the
  // reader's own marks are kept — the rectangles may now point at the wrong
  // place, but only the reader can judge that, and the snapshot still says what
  // was marked.
  const stale = marksAreStale(path, stamp);
  return (
    <section className="record-marks" aria-label={t("preview.marks")}>
      <h3 className="record-marks-title">{t("preview.marks")}</h3>
      {stale && <p className="mark-stale-note">{t("marks.staleFile")}</p>}
      <ul className="record-mark-list">
        {/* Added and deleted the same way the findings above are: the list is
            one ledger, and both halves move alike. */}
        <AnimatePresence initial={false}>
          {marks.map((mark) => (
            <motion.li key={mark.id} className="record-mark" {...entryMotion}>
              <Button
                variant="ghost"
                size="sm"
                className="record-mark-row"
                title={mark.note || mark.text || t("marks.noText")}
                onClick={() =>
                  onSelectMark ? onSelectMark(mark.page, mark.id) : onJumpToPage(mark.page)
                }
              >
                <span className="record-mark-text">
                  {mark.note || mark.text || t("marks.noText")}
                </span>
                <span
                  className={`record-mark-page${mark.page === currentPage ? " record-mark-here" : ""}`}
                >
                  {mark.page}
                </span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon
                className="record-mark-delete"
                title={t("marks.delete")}
                aria-label={t("marks.delete")}
                onClick={() => removeMark(path, mark.id)}
              >
                <Trash2 size={13} />
              </Button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

/**
 * One entry, and the pages it came from.
 *
 * The pages are controls, not decoration: a claim the reader cannot trace back
 * to the text is the failure this record has to avoid, and the assistant is
 * told these again on the next question.
 */
function RecordEntry({
  path,
  finding,
  all,
  stamp,
  totalPages,
  currentPage,
  onJumpToPage,
  onRevealFinding,
  onRevealMessage,
  hasMessage,
}: {
  path: string;
  finding: Finding;
  all: readonly Finding[];
  stamp: string;
  totalPages: number;
  currentPage: number;
  onJumpToPage: (page: number) => void;
  onRevealFinding?: (id: string, page: number) => void;
  onRevealMessage?: (messageId: string) => void;
  hasMessage?: (messageId: string) => boolean;
}) {
  const { t } = useI18n();
  const placement = useFindingPlacement(path, finding);
  const entryMotion = useEntryMotion();
  const [showBody, setShowBody] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(finding.claim);
  const struck = Boolean(finding.struck);
  const byReader = finding.author === "reader";
  const trust: Trust = trustOf(finding, { stamp, totalPages, all, placement });
  const inactive = trust === "retracted";
  const superseded = all.some((f) => f.supersedes === finding.id);

  const submitEdit = () => {
    setFindingClaim(path, finding.id, draft, stamp || undefined);
    setEditing(false);
  };

  return (
    <motion.li
      className={`record-entry ${inactive ? "record-entry-inactive" : ""}`}
      data-trust={trust}
      data-level={recordLevel(trust)}
      {...entryMotion}
    >
      <div className="record-entry-head">
        <span className={`record-byline ${byReader ? "record-byline-reader" : ""}`}>
          {byReader ? <User size={11} aria-hidden /> : <Sparkles size={11} aria-hidden />}
          {byReader ? t("record.byReader") : t("record.byAssistant")}
        </span>
        {inactive && (
          <span className="record-state">
            {struck
              ? t("marks.struck")
              : superseded
                ? t("marks.replaced")
                : t(longKey("retracted"))}
          </span>
        )}
        {!inactive && !editing && (
          <Button
            variant="ghost"
            size="sm"
            icon
            className="record-edit"
            title={t("record.editClaim")}
            aria-label={t("record.editClaim")}
            onClick={() => {
              setDraft(finding.claim);
              setEditing(true);
            }}
          >
            <Pencil size={13} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon
          className="record-strike"
          title={struck ? t("marks.unstrike") : t("marks.strike")}
          aria-label={struck ? t("marks.unstrike") : t("marks.strike")}
          onClick={() => setFindingStruck(path, finding.id, !struck)}
        >
          <Undo2 size={13} />
        </Button>
      </div>
      {editing ? (
        <form
          className="record-edit-form"
          onSubmit={(e) => {
            e.preventDefault();
            submitEdit();
          }}
        >
          <Input
            size="sm"
            value={draft}
            aria-label={t("record.claimLabel")}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <div className="record-edit-actions">
            <Button type="submit" variant="secondary" size="sm" disabled={!draft.trim()}>
              {t("record.saveClaim")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              {t("record.cancelEdit")}
            </Button>
          </div>
        </form>
      ) : (
        <p className="record-claim">{finding.claim}</p>
      )}
      {finding.why && <p className="record-why">{finding.why}</p>}
      {finding.evidence && <p className="record-evidence">{finding.evidence}</p>}
      {finding.body && (
        <>
          <Button
            variant="link"
            size="sm"
            className="record-body-toggle"
            aria-expanded={showBody}
            onClick={() => setShowBody((v) => !v)}
          >
            {showBody ? <ChevronUp size={11} aria-hidden /> : <ChevronDown size={11} aria-hidden />}
            {showBody ? t("record.hideBody") : t("record.showBody")}
          </Button>
          {showBody && (
            <div className="record-body" aria-label={t("record.bodyOf")}>
              <Markdown>{finding.body}</Markdown>
            </div>
          )}
        </>
      )}
      {!inactive && (
        <TrustLine
          finding={finding}
          trust={trust}
          placement={placement}
          path={path}
          stamp={stamp}
          onRevealFinding={onRevealFinding}
        />
      )}
      <div className="record-pages">
        {finding.pages.map((page) => (
          <Button
            key={page}
            variant="ghost"
            size="sm"
            className={`record-page-chip ${page === currentPage ? "here" : ""}`}
            title={t("preview.pageTitle", { page })}
            onClick={() => onJumpToPage(page)}
          >
            {page}
          </Button>
        ))}
        {finding.source && onRevealMessage && (hasMessage?.(finding.source.messageId) ?? true) && (
          <Button
            variant="ghost"
            size="sm"
            className="record-page-chip record-source-chip"
            onClick={() => onRevealMessage(finding.source!.messageId)}
          >
            <MessageSquare size={11} aria-hidden />
            {t("record.backToAnswer")}
          </Button>
        )}
      </div>
    </motion.li>
  );
}

/**
 * The one line that says how far to trust this, and the one control that can
 * change it. Located: a button to the passage. Anything the reader can
 * settle: "I checked this". Confirmed: the way back out.
 */
function TrustLine({
  finding,
  trust,
  placement,
  path,
  stamp,
  onRevealFinding,
}: {
  finding: Finding;
  trust: Trust;
  placement: ReturnType<typeof useFindingPlacement>;
  path: string;
  stamp: string;
  onRevealFinding?: (id: string, page: number) => void;
}) {
  const { t } = useI18n();
  if (trust === "located" && placement?.status === "located") {
    return (
      <Button
        variant="link"
        size="sm"
        className="record-locate record-locate-found"
        onClick={() => onRevealFinding?.(finding.id, placement.anchor.page)}
      >
        <Crosshair size={11} aria-hidden />
        {t(longKey("located"), { page: placement.anchor.page })}
      </Button>
    );
  }
  if (trust === "confirmed") {
    return (
      <p className="record-locate record-locate-confirmed">
        <Check size={11} aria-hidden />
        {t(longKey("confirmed"))}
        <Button
          variant="link"
          size="sm"
          className="record-trust-action"
          onClick={() => confirmFinding(path, finding.id, false)}
        >
          {t("record.unconfirm")}
        </Button>
      </p>
    );
  }
  if (trust === "retracted") return null;
  // The level first, the reason after it — the same three words as the chips
  // in the answer, and the same sentence (16.0, one table of both).
  const level = recordLevel(trust);
  const doubtful = level === "check" || level === "notFound";
  // A mismatch names the numbers the claim states and the passage does not;
  // the reason is only given for a placement that has them (finding-trust.ts).
  const mismatch = placement?.status === "mismatch" ? placement : null;
  const text = t(longKey(trust), {
    page: mismatch?.anchor.page ?? finding.pages[0],
    numbers: mismatch ? mismatch.unstated.join("、") : "",
  });
  return (
    <p className={`record-locate ${doubtful ? `record-locate-${level}` : "record-locate-unverified"}`}>
      {doubtful && <AlertTriangle size={11} aria-hidden />}
      {doubtful && <span className="record-level">{t(`level.${level}`)}</span>}
      {text}
      {trustNeedsReader(trust) && (
        <Button
          variant="link"
          size="sm"
          className="record-trust-action"
          onClick={() => confirmFinding(path, finding.id, true, stamp || undefined)}
        >
          {t("record.confirm")}
        </Button>
      )}
    </p>
  );
}
