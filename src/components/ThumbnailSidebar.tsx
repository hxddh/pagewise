import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { renderThumbnail } from "../lib/pdf";

interface ThumbnailSidebarProps {
  path: string;
  totalPages: number;
  currentPage: number;
  collapsed: boolean;
  onToggle: () => void;
  onPageSelect: (page: number) => void;
}

function ThumbnailItem({
  path,
  page,
  active,
  onSelect,
  pageLabel,
}: {
  path: string;
  page: number;
  active: boolean;
  onSelect: () => void;
  pageLabel: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) return;
    const el = rootRef.current;
    const container = el?.parentElement;
    if (!el || !container) return;
    // Only auto-scroll when the active thumb is actually out of view, so we
    // don't fight the user's manual scrolling as follow-mode flips pages.
    const elRect = el.getBoundingClientRect();
    const boxRect = container.getBoundingClientRect();
    const outOfView = elRect.top < boxRect.top || elRect.bottom > boxRect.bottom;
    if (outOfView) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "120px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !canvasRef.current) return;
    let cancelled = false;
    renderThumbnail(path, page, canvasRef.current).catch(() => {
      if (!cancelled && canvasRef.current) {
        const ctx = canvasRef.current.getContext("2d");
        if (ctx) {
          // Resolve the theme token so the error fill matches light/dark.
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
    >
      <canvas ref={canvasRef} className="thumb-canvas" />
      <span className="thumb-label">{page}</span>
    </button>
  );
}

export function ThumbnailSidebar({
  path,
  totalPages,
  currentPage,
  collapsed,
  onToggle,
  onPageSelect,
}: ThumbnailSidebarProps) {
  const { t } = useI18n();

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
      <div className="thumb-list">
        {/*
          NOTE: all page buttons are mounted eagerly. Thumbnail rendering itself
          is deferred via IntersectionObserver (only visible canvases paint), so
          the cost is DOM nodes rather than PDF work. For very large documents a
          windowed/virtualized list would further reduce DOM overhead.
        */}
        {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
          <ThumbnailItem
            key={page}
            path={path}
            page={page}
            active={page === currentPage}
            onSelect={() => onPageSelect(page)}
            pageLabel={t("preview.pageTitle", { page })}
          />
        ))}
      </div>
    </aside>
  );
}
