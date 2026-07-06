import { memo, useCallback, useEffect, useRef } from "react";
import { FileImage, FileText, X } from "lucide-react";
import { useI18n } from "../i18n";
import type { RecentFile } from "../lib/recent-files";
import { useOverlayLock } from "../hooks/useOverlayLock";
import { useFocusTrap } from "../hooks/useFocusTrap";
import {
  isTopOverlayLayer,
  popOverlayLayer,
  pushOverlayLayer,
} from "../lib/overlay-state";

interface RecentFilesDrawerProps {
  open: boolean;
  recentFiles: RecentFile[];
  activePath: string | null;
  opening?: boolean;
  onClose: () => void;
  onOpenFile: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
}

function formatOpenedAt(
  openedAt: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const deltaMs = Date.now() - openedAt;
  if (deltaMs < 60_000) return t("library.justNow");
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return t("library.minutesAgo", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t("library.hoursAgo", { n: hours });
  const days = Math.floor(hours / 24);
  return t("library.daysAgo", { n: days });
}

function pathSummary(path: string): string {
  const parts = path.split(/[/\\]/);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

function RecentFilesDrawerInner({
  open,
  recentFiles,
  activePath,
  opening = false,
  onClose,
  onOpenFile,
  onOpenRecent,
  onRemoveRecent,
}: RecentFilesDrawerProps) {
  const { t } = useI18n();
  useOverlayLock(open);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, panelRef);

  const requestClose = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (!open) return;
    const layerId = pushOverlayLayer();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopOverlayLayer(layerId)) {
        e.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      popOverlayLayer(layerId);
    };
  }, [open, requestClose]);

  if (!open) return null;

  const handleOpenRecent = (path: string) => {
    onClose();
    onOpenRecent(path);
  };

  return (
    <div className="library-drawer-root" role="presentation">
      <button
        type="button"
        className="library-drawer-backdrop"
        aria-label={t("library.close")}
        onClick={requestClose}
      />
      <aside
        ref={panelRef}
        className="library-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t("sidebar.library")}
      >
        <header className="library-drawer-header">
          <h2>{t("sidebar.library")}</h2>
          <button
            type="button"
            className="btn icon-btn"
            onClick={requestClose}
            aria-label={t("library.close")}
          >
            <X size={16} />
          </button>
        </header>

        <button
          type="button"
          className="btn primary library-drawer-open"
          onClick={() => {
            onClose();
            onOpenFile();
          }}
          disabled={opening}
        >
          {opening ? t("sidebar.opening") : t("sidebar.openDocument")}
        </button>

        <div className="library-drawer-body document-library">
          <p className="library-section-label">{t("sidebar.recent")}</p>
          {recentFiles.length === 0 ? (
            <div className="library-empty">
              <p>{t("library.emptyRecent")}</p>
              <p>{t("library.emptyRecentHint")}</p>
            </div>
          ) : (
            <ul className="library-list">
              {recentFiles.map((file) => {
                const active = file.path === activePath;
                const Icon = file.kind === "image" ? FileImage : FileText;
                return (
                  <li key={file.path} className={active ? "active" : undefined}>
                    <button
                      type="button"
                      className="library-item library-item-history"
                      onClick={() => handleOpenRecent(file.path)}
                      disabled={opening}
                      title={file.path}
                    >
                      <span className="library-name">
                        <Icon
                          size={14}
                          strokeWidth={1.75}
                          aria-hidden
                          style={{ display: "inline", verticalAlign: "-2px", marginRight: 6 }}
                        />
                        {file.name}
                      </span>
                      <span className="library-meta">
                        {formatOpenedAt(file.openedAt, t)} · {pathSummary(file.path)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="library-remove"
                      aria-label={t("library.remove")}
                      title={t("library.remove")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveRecent(file.path);
                      }}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

export const RecentFilesDrawer = memo(RecentFilesDrawerInner);
