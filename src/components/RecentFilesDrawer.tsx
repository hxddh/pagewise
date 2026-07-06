import { memo, useCallback, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useI18n } from "../i18n";
import type { RecentFile } from "../lib/recent-files";
import { RecentFilesList } from "./RecentFilesList";
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
          <RecentFilesList
            files={recentFiles}
            layout="drawer"
            activePath={activePath}
            opening={opening}
            onOpen={handleOpenRecent}
            onRemove={onRemoveRecent}
          />
        </div>
      </aside>
    </div>
  );
}

export const RecentFilesDrawer = memo(RecentFilesDrawerInner);
