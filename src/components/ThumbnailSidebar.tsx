import { ChevronLeft, ChevronRight } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { renderThumbnail } from "../lib/pdf";

const THUMB_ROW_HEIGHT = 112;
const OVERSCAN = 4;

interface ThumbnailSidebarProps {
  path: string;
  totalPages: number;
  currentPage: number;
  collapsed: boolean;
  onToggle: () => void;
  onPageSelect: (page: number) => void;
}

const ThumbnailItem = memo(function ThumbnailItem({
  path,
  page,
  active,
  onSelect,
  pageLabel,
  visible,
}: {
  path: string;
  page: number;
  active: boolean;
  onSelect: () => void;
  pageLabel: string;
  visible: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!active) return;
    const el = rootRef.current;
    const container = el?.closest(".thumb-list");
    if (!el || !container) return;
    const elRect = el.getBoundingClientRect();
    const boxRect = container.getBoundingClientRect();
    const outOfView = elRect.top < boxRect.top || elRect.bottom > boxRect.bottom;
    if (outOfView) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  useEffect(() => {
    if (!visible || !canvasRef.current) return;
    let cancelled = false;
    renderThumbnail(path, page, canvasRef.current).catch(() => {
      if (!cancelled && canvasRef.current) {
        const ctx = canvasRef.current.getContext("2d");
        if (ctx) {
          const fill =
            getComputedStyle(document.documentElement)
              .getPropertyValue("--bg-hover")
              .trim() || "#1a1a1e";
          ctx.fillStyle = fill;
          ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [visible, path, page]);

  return (
    <button
      ref={rootRef}
      type="button"
      className={`thumb-item ${active ? "active" : ""}`}
      onClick={onSelect}
      title={pageLabel}
      aria-label={pageLabel}
      aria-current={active ? "page" : undefined}
      style={{ height: THUMB_ROW_HEIGHT }}
    >
      <canvas ref={canvasRef} className="thumb-canvas" />
      <span className="thumb-label">{page}</span>
    </button>
  );
});

export const ThumbnailSidebar = memo(function ThumbnailSidebar({
  path,
  totalPages,
  currentPage,
  collapsed,
  onToggle,
  onPageSelect,
}: ThumbnailSidebarProps) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 1, end: Math.min(totalPages, 12) });

  const updateRange = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const start = Math.max(1, Math.floor(el.scrollTop / THUMB_ROW_HEIGHT) + 1 - OVERSCAN);
    const visibleCount = Math.ceil(el.clientHeight / THUMB_ROW_HEIGHT) + OVERSCAN * 2;
    const end = Math.min(totalPages, start + visibleCount);
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [totalPages]);

  useEffect(() => {
    updateRange();
  }, [totalPages, updateRange]);

  if (collapsed) {
    return (
      <button
        type="button"
        className="thumb-collapse-rail"
        onClick={onToggle}
        title={t("preview.thumbnailsShow")}
        aria-label={t("preview.thumbnailsShow")}
      >
        <ChevronRight size={14} />
      </button>
    );
  }

  const pages: number[] = [];
  for (let p = range.start; p <= range.end; p++) pages.push(p);

  return (
    <aside className="thumb-sidebar" aria-label={t("preview.pages")}>
      <div className="thumb-sidebar-header">
        <span>{t("preview.pages")}</span>
        <button
          type="button"
          className="toolbar-btn"
          onClick={onToggle}
          title={t("preview.thumbnailsHide")}
          aria-label={t("preview.thumbnailsHide")}
        >
          <ChevronLeft size={14} />
        </button>
      </div>
      <div
        className="thumb-list"
        ref={listRef}
        onScroll={updateRange}
        style={{ position: "relative" }}
      >
        <div style={{ height: (range.start - 1) * THUMB_ROW_HEIGHT }} aria-hidden />
        {pages.map((page) => (
          <ThumbnailItem
            key={page}
            path={path}
            page={page}
            active={page === currentPage}
            onSelect={() => onPageSelect(page)}
            pageLabel={t("preview.pageTitle", { page })}
            visible
          />
        ))}
        <div
          style={{ height: Math.max(0, (totalPages - range.end) * THUMB_ROW_HEIGHT) }}
          aria-hidden
        />
      </div>
    </aside>
  );
});
