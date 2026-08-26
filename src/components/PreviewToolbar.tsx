import { LayoutGrid, SquareDashedMousePointer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { ZoomMode } from "../lib/zoom";
import { IconChevronLeft, IconChevronRight } from "./Icon";
import { ZoomStepper } from "./ZoomStepper";
import { Button } from "./ui/Button";
import { Input } from "./ui/Field";
import { labelForPage, pageForLabel } from "../lib/page-labels";

interface PreviewToolbarProps {
  filename: string;
  page: number;
  totalPages: number;
  /** What the pages call themselves, when that differs from where they sit. */
  pageLabels?: string[];
  zoom: ZoomMode;
  onZoomChange: (zoom: ZoomMode) => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  zoomDisabled?: boolean;
  onPageChange: (page: number) => void;
  thumbsVisible: boolean;
  onToggleThumbs: () => void;
  /** Region-marking mode. Absent on documents that cannot be marked. */
  regionMode?: boolean;
  onToggleRegionMode?: () => void;
}

function PageNav({
  page,
  totalPages,
  pageLabels,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  pageLabels?: string[];
  onPageChange: (page: number) => void;
}) {
  const { t } = useI18n();
  // What is printed on this page, when it is not simply the page's position.
  const printed = labelForPage(pageLabels ?? null, page);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(page));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(String(page));
  }, [page]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (totalPages <= 1) return null;

  function commit() {
    // A printed number first, when the document prints any. The reader is
    // looking at a footer that says 47; typing 47 has to land there, not on
    // the 47th sheet. Falls through to the position when the number is not
    // printed anywhere, or is printed on more than one page.
    const byLabel = pageForLabel(pageLabels ?? null, draft);
    if (byLabel !== null) {
      onPageChange(byLabel);
      setDraft(String(byLabel));
      setEditing(false);
      return;
    }
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n)) {
      setDraft(String(page));
      setEditing(false);
      return;
    }
    const clamped = Math.min(totalPages, Math.max(1, n));
    onPageChange(clamped);
    setDraft(String(clamped));
    setEditing(false);
  }

  return (
    <div className="toolbar-group toolbar-group-page">
      <Button variant="ghost" size="md"
       
        className="toolbar-btn"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        title={t("preview.previousPageHint")}
        aria-label={t("preview.previousPage")}
      >
        <IconChevronLeft size={14} />
      </Button>
      {editing ? (
        <Input
          ref={inputRef}
          size="sm"
          numeric
          className="toolbar-page-input"
          value={draft}
          // Digits only where pages are numbered with digits; a document that
          // prints "iv" or "A-1" needs those characters to reach `commit`.
          onChange={(e) =>
            setDraft(
              pageLabels ? e.target.value.slice(0, 24) : e.target.value.replace(/\D/g, ""),
            )
          }
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              setDraft(String(page));
              setEditing(false);
            }
          }}
          aria-label={t("preview.pageOf", { page, total: totalPages })}
        />
      ) : (
        <Button variant="ghost" size="md"
         
          className="toolbar-btn toolbar-page-label"
          onClick={() => setEditing(true)}
          title={t("preview.pageOf", { page, total: totalPages })}
          aria-label={t("preview.pageOf", { page, total: totalPages })}
        >
          {/* The printed number leads, because it is the one on the paper in
              front of the reader; the position follows it, quieter. Shown only
              where the two disagree — on a document numbered the obvious way
              this is noise. */}
          {printed ? <span className="toolbar-page-printed">{printed}</span> : null}
          <span className="toolbar-page-current">{page}</span>
          <span className="toolbar-page-sep">/</span>
          <span className="toolbar-page-total">{totalPages}</span>
        </Button>
      )}
      <Button variant="ghost" size="md"
       
        className="toolbar-btn"
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
        title={t("preview.nextPageHint")}
        aria-label={t("preview.nextPage")}
      >
        <IconChevronRight size={14} />
      </Button>
    </div>
  );
}

export function PreviewToolbar({
  filename,
  page,
  totalPages,
  pageLabels,
  zoom,
  onZoomChange,
  onZoomIn,
  onZoomOut,
  zoomDisabled,
  onPageChange,
  thumbsVisible,
  onToggleThumbs,
  regionMode,
  onToggleRegionMode,
}: PreviewToolbarProps) {
  const { t } = useI18n();

  const basename = filename.includes("/")
    ? filename.slice(filename.lastIndexOf("/") + 1)
    : filename;

  return (
    <header className="preview-toolbar preview-toolbar-slim">
      <div className="toolbar-left">
        <span className="preview-filename" title={filename}>
          {basename}
        </span>
      </div>

      <div className="preview-toolbar-center">
        <PageNav
          page={page}
          totalPages={totalPages}
          pageLabels={pageLabels}
          onPageChange={onPageChange}
        />
      </div>

      <div className="toolbar-right">
        {totalPages > 1 && (
          <div className="toolbar-group">
            <Button variant="ghost" size="md"
             
              className={`toolbar-btn ${thumbsVisible ? "active" : ""}`}
              onClick={onToggleThumbs}
              title={thumbsVisible ? t("preview.thumbnailsHide") : t("preview.thumbnailsShow")}
              aria-label={thumbsVisible ? t("preview.thumbnailsHide") : t("preview.thumbnailsShow")}
              aria-pressed={thumbsVisible}
            >
              <LayoutGrid size={14} strokeWidth={1.75} />
            </Button>
          </div>
        )}
        {onToggleRegionMode && (
          <div className="toolbar-group">
            <Button variant="ghost" size="md"
             
              className={`toolbar-btn ${regionMode ? "active" : ""}`}
              onClick={onToggleRegionMode}
              title={t("marks.regionMode")}
              aria-label={t("marks.regionMode")}
              aria-pressed={!!regionMode}
            >
              <SquareDashedMousePointer size={14} strokeWidth={1.75} />
            </Button>
          </div>
        )}
        <ZoomStepper
          zoom={zoom}
          onZoomChange={onZoomChange}
          onZoomIn={onZoomIn ?? (() => {})}
          onZoomOut={onZoomOut ?? (() => {})}
          disabled={zoomDisabled}
        />
      </div>
    </header>
  );
}
