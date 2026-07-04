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
    if (active) rootRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
          ctx.fillStyle = "#1a1a1e";
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
