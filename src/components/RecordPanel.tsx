import { memo, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Crosshair,
  MessageSquare,
  Pencil,
  Sparkles,
  Undo2,
  User,
} from "lucide-react";
import { useI18n } from "../i18n";
import {
  confirmFinding,
  getFindings,
  setFindingClaim,
  setFindingStruck,
  type Finding,
} from "../lib/finding-store";
import { useFindingPlacement } from "../hooks/useFindingPlacement";
import { trustNeedsReader, trustOf, type Trust } from "../lib/finding-trust";
import { Button } from "./ui/Button";
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
  /** Show the answer an entry was kept from. */
  onRevealMessage?: (messageId: string) => void;
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
  onRevealMessage,
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

  if (total === 0) {
    return (
      <div className="record-panel record-empty">
        <p>{t("record.empty")}</p>
        <p className="record-empty-hint">{t("record.emptyHint")}</p>
      </div>
    );
  }

  return (
    <div className="record-panel">
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
        <p className="record-none">{t("record.noMatch")}</p>
      ) : (
        <ul className="record-list">
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
            />
          ))}
        </ul>
      )}
    </div>
  );
});

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
}) {
  const { t } = useI18n();
  const placement = useFindingPlacement(path, finding);
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
    <li
      className={`record-entry ${inactive ? "record-entry-inactive" : ""}`}
      data-trust={trust}
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
                : t("record.trustRetracted")}
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
          {/* raw-button: a disclosure line under the claim — reads as text with a chevron, not as a control */}
          <button
            type="button"
            className="record-body-toggle"
            aria-expanded={showBody}
            onClick={() => setShowBody((v) => !v)}
          >
            {showBody ? <ChevronUp size={11} aria-hidden /> : <ChevronDown size={11} aria-hidden />}
            {showBody ? t("record.hideBody") : t("record.showBody")}
          </button>
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
          /* raw-button: an inline page chip in a row of them; a control's padding would break the line */
          <button
            key={page}
            type="button"
            className={`record-page-chip ${page === currentPage ? "here" : ""}`}
            title={t("preview.pageTitle", { page })}
            onClick={() => onJumpToPage(page)}
          >
            {page}
          </button>
        ))}
        {finding.source && onRevealMessage && (
          /* raw-button: sits in the chip row and has to match the chips beside it */
          <button
            type="button"
            className="record-page-chip record-source-chip"
            onClick={() => onRevealMessage(finding.source!.messageId)}
          >
            <MessageSquare size={11} aria-hidden />
            {t("record.backToAnswer")}
          </button>
        )}
      </div>
    </li>
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
      /* raw-button: a status line that is also the control that acts on it */
      <button
        type="button"
        className="record-locate record-locate-found"
        onClick={() => onRevealFinding?.(finding.id, placement.anchor.page)}
      >
        <Crosshair size={11} aria-hidden />
        {t("record.trustLocated", { page: placement.anchor.page })}
      </button>
    );
  }
  if (trust === "confirmed") {
    return (
      <p className="record-locate record-locate-confirmed">
        <Check size={11} aria-hidden />
        {t("record.trustConfirmed")}
        {/* raw-button: an inline affordance at the end of a status line */}
        <button
          type="button"
          className="record-trust-action"
          onClick={() => confirmFinding(path, finding.id, false)}
        >
          {t("record.unconfirm")}
        </button>
      </p>
    );
  }
  if (trust === "retracted") return null;
  const doubtful = trust === "unlocated" || trust === "unreadable" || trust === "stale";
  const text =
    trust === "unlocated"
      ? t("record.trustUnlocated")
      : trust === "unreadable"
        ? t("record.trustUnreadable")
        : trust === "stale"
          ? t("record.trustStale")
          : t("record.trustUnverified");
  return (
    <p className={`record-locate ${doubtful ? "record-locate-absent" : "record-locate-unverified"}`}>
      {doubtful && <AlertTriangle size={11} aria-hidden />}
      {text}
      {trustNeedsReader(trust) && (
        /* raw-button: an inline affordance at the end of a status line */
        <button
          type="button"
          className="record-trust-action"
          onClick={() => confirmFinding(path, finding.id, true, stamp || undefined)}
        >
          {t("record.confirm")}
        </button>
      )}
    </p>
  );
}
