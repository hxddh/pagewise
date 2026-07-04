import { LayoutGrid } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { ZoomMode } from "../lib/zoom";
import { IconChevronLeft, IconChevronRight } from "./Icon";
import { ZoomStepper } from "./ZoomStepper";

interface PreviewToolbarProps {
  filename: string;
  page: number;
  totalPages: number;
  zoom: ZoomMode;
  onZoomChange: (zoom: ZoomMode) => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  zoomDisabled?: boolean;
  onPageChange: (page: number) => void;
  thumbsVisible: boolean;
  onToggleThumbs: () => void;
}

function PageNav({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useI18n();
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
      <button
        type="button"
        className="toolbar-btn"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        title={t("preview.previousPageHint")}
        aria-label={t("preview.previousPage")}
      >
        <IconChevronLeft size={14} />
      </button>
      {editing ? (
        <input
          ref={inputRef}
          className="toolbar-page-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))}
          onBlur={commit}
          onKeyDown={(e) => {
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
        <button
          type="button"
          className="toolbar-btn toolbar-page-label"
          onClick={() => setEditing(true)}
          title={t("preview.pageOf", { page, total: totalPages })}
          aria-label={t("preview.pageOf", { page, total: totalPages })}
        >
          <span className="toolbar-page-current">{page}</span>
          <span className="toolbar-page-sep">/</span>
          <span className="toolbar-page-total">{totalPages}</span>
        </button>
      )}
      <button
        type="button"
        className="toolbar-btn"
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
        title={t("preview.nextPageHint")}
        aria-label={t("preview.nextPage")}
      >
        <IconChevronRight size={14} />
      </button>
    </div>
  );
}

export function PreviewToolbar({
  filename,
  page,
  totalPages,
  zoom,
  onZoomChange,
  onZoomIn,
  onZoomOut,
  zoomDisabled,
  onPageChange,
  thumbsVisible,
  onToggleThumbs,
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
        <PageNav page={page} totalPages={totalPages} onPageChange={onPageChange} />
      </div>

      <div className="toolbar-right">
        {totalPages > 1 && (
          <div className="toolbar-group">
            <button
              type="button"
              className={`toolbar-btn ${thumbsVisible ? "active" : ""}`}
              onClick={onToggleThumbs}
              title={thumbsVisible ? t("preview.thumbnailsHide") : t("preview.thumbnailsShow")}
              aria-label={thumbsVisible ? t("preview.thumbnailsHide") : t("preview.thumbnailsShow")}
              aria-pressed={thumbsVisible}
            >
              <LayoutGrid size={14} strokeWidth={1.75} />
            </button>
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
