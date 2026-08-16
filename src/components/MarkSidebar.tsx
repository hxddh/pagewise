import { MessageSquareQuote, Sparkles, Undo2 } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { getMarks, type Mark } from "../lib/mark-store";
import {
  getFindings,
  isSuperseded,
  setFindingStruck,
  type Finding,
} from "../lib/finding-store";
import { Button } from "./ui/Button";
import { Input } from "./ui/Field";

interface MarkSidebarProps {
  path: string;
  /** Changes when this document's marks do, so the list re-reads them. */
  revision: number;
  currentPage: number;
  selectedId: string | null;
  /** Some marks were made against a different version of this file. */
  stale: boolean;
  /** Rendered in the header so the sidebars switch in place. */
  tabs: React.ReactNode;
  onSelect: (page: number, id: string) => void;
  /** Put this mark into the composer. Absent when there is nothing to ask. */
  onAsk?: (mark: Mark) => void;
}

/** A mark or a finding, placed on the page it belongs to. */
type Entry =
  | { kind: "mark"; page: number; at: number; mark: Mark }
  | { kind: "finding"; page: number; at: number; finding: Finding; superseded: boolean };

/**
 * The record: everything known about this document, by either author.
 *
 * The reader's marks and the assistant's findings are one list because they are
 * the same kind of thing — *this passage means this* — and splitting them into
 * two lists would ask the reader to look in two places for one answer.
 *
 * They are never the same colour. A finding is the assistant's inference and a
 * mark is the reader's own act, and a record that blurs the two is worse than
 * no record: the reader would have no way to tell what came off the page from
 * what was worked out about it. Every finding carries its pages for the same
 * reason — the claim must always be checkable against the text.
 *
 * Findings sort by their first page, so a claim spanning 4-7 sits at 4 among
 * the marks. Struck and superseded ones stay visible: the reader needs to see
 * what they struck in order to undo it, and a revision that hid what it
 * overturned would leave no trace of the assistant having been wrong.
 */
export const MarkSidebar = memo(function MarkSidebar({
  path,
  revision,
  currentPage,
  selectedId,
  stale,
  tabs,
  onSelect,
  onAsk,
}: MarkSidebarProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  // `revision` is the subscription; the record itself is read synchronously.
  const entries = useMemo(() => {
    void revision;
    const findings = getFindings(path);
    const rows: Entry[] = [
      ...getMarks(path).map<Entry>((mark) => ({
        kind: "mark",
        page: mark.page,
        at: mark.createdAt,
        mark,
      })),
      ...findings.map<Entry>((finding) => ({
        kind: "finding",
        page: finding.pages[0] ?? 1,
        at: finding.createdAt,
        finding,
        superseded: isSuperseded(findings, finding.id),
      })),
    ];
    // Notes and claims are in no search index — ⌘F covers the document,
    // deliberately not this. Once there are fifty entries, "where did I write
    // that" needs an answer somewhere.
    const needle = filter.trim().normalize("NFC").toLowerCase();
    const matched = needle
      ? rows.filter((row) => {
          const hay =
            row.kind === "mark"
              ? `${row.mark.text}\n${row.mark.note}`
              : `${row.finding.claim}\n${row.finding.evidence}`;
          return hay.normalize("NFC").toLowerCase().includes(needle);
        })
      : rows;
    return [...matched].sort((a, b) => a.page - b.page || a.at - b.at);
  }, [path, revision, filter]);

  return (
    <aside className="thumb-sidebar outline-sidebar" aria-label={t("preview.marks")}>
      <div className="thumb-sidebar-header">
        {tabs}
      </div>
      {stale && <p className="mark-stale-note">{t("marks.staleFile")}</p>}
      {(entries.length > 0 || filter) && (
        <Input
          type="search"
          size="sm"
          className="mark-filter"
          value={filter}
          placeholder={t("marks.filterPlaceholder")}
          aria-label={t("marks.filterPlaceholder")}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {entries.length === 0 ? (
        <p className="outline-empty">{filter ? t("marks.noFilterMatch") : t("marks.empty")}</p>
      ) : (
        <nav className="outline-list">
          {entries.map((entry) =>
            entry.kind === "finding" ? (
              <FindingRow
                key={entry.finding.id}
                path={path}
                finding={entry.finding}
                superseded={entry.superseded}
                currentPage={currentPage}
                onSelect={onSelect}
              />
            ) : (
              <MarkRow
                key={entry.mark.id}
                mark={entry.mark}
                selectedId={selectedId}
                currentPage={currentPage}
                onSelect={onSelect}
                onAsk={onAsk}
              />
            ),
          )}
        </nav>
      )}
    </aside>
  );
});

/**
 * One passage the reader marked.
 *
 * A row rather than a bare button: marking a passage and then asking about it
 * is the reason to mark it, and before this the only way was to find the page,
 * find the passage and select it again.
 */
function MarkRow({
  mark,
  selectedId,
  currentPage,
  onSelect,
  onAsk,
}: {
  mark: Mark;
  selectedId: string | null;
  currentPage: number;
  onSelect: (page: number, id: string) => void;
  onAsk?: (mark: Mark) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mark-row">
      {/* raw-button: a list row carrying page, quote and note; Button would flatten it */}
      <button
        type="button"
        className={`outline-item mark-item ${
          mark.id === selectedId ? "active" : mark.page === currentPage ? "mark-item-here" : ""
        }`}
        aria-current={mark.id === selectedId ? "true" : undefined}
        title={mark.note || mark.text}
        onClick={() => onSelect(mark.page, mark.id)}
      >
        <span className="outline-title">
          <span className="mark-item-text">{mark.text || t("marks.noText")}</span>
          {mark.note && <span className="mark-item-note">{mark.note}</span>}
        </span>
        <span className="outline-page">{mark.page}</span>
      </button>
      {onAsk && (
        <Button
          variant="ghost"
          size="sm"
          icon
          className="mark-ask-btn"
          title={t("marks.ask")}
          aria-label={t("marks.ask")}
          onClick={() => onAsk(mark)}
        >
          <MessageSquareQuote size={13} />
        </Button>
      )}
    </div>
  );
}

/**
 * One thing the assistant established, and the pages it came from.
 *
 * The pages are the whole point: a claim the reader cannot trace back to the
 * text is the failure this record has to avoid, because the assistant is told
 * it again next turn and the reader has no way to check it. So they are
 * rendered as controls that go there, never as decoration.
 */
function FindingRow({
  path,
  finding,
  superseded,
  currentPage,
  onSelect,
}: {
  path: string;
  finding: Finding;
  superseded: boolean;
  currentPage: number;
  onSelect: (page: number, id: string) => void;
}) {
  const { t } = useI18n();
  const struck = Boolean(finding.struck);
  const here = finding.pages.includes(currentPage);
  return (
    <div className={`mark-row finding-row ${struck || superseded ? "finding-row-inactive" : ""}`}>
      {/* raw-button: a list row carrying the claim, its pages and its state; Button would flatten it */}
      <button
        type="button"
        className={`outline-item mark-item finding-item ${here ? "mark-item-here" : ""}`}
        title={finding.evidence || finding.claim}
        onClick={() => onSelect(finding.pages[0] ?? 1, finding.id)}
      >
        <span className="outline-title">
          <span className="finding-byline">
            <Sparkles size={11} aria-hidden />
            {t("marks.agentFinding")}
          </span>
          <span className="mark-item-text finding-claim">{finding.claim}</span>
          {finding.why && <span className="mark-item-note">{finding.why}</span>}
          {(struck || superseded) && (
            <span className="finding-state">
              {struck ? t("marks.struck") : t("marks.replaced")}
            </span>
          )}
        </span>
        <span className="outline-page">{finding.pages.join(", ")}</span>
      </button>
      <Button
        variant="ghost"
        size="sm"
        icon
        className="mark-ask-btn"
        title={struck ? t("marks.unstrike") : t("marks.strike")}
        aria-label={struck ? t("marks.unstrike") : t("marks.strike")}
        onClick={() => setFindingStruck(path, finding.id, !struck)}
      >
        <Undo2 size={13} />
      </Button>
    </div>
  );
}
