import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import { DocumentLibrary } from "./DocumentLibrary";
import type { StoredChatSession } from "../lib/chat-sessions";
import type { RecentFile } from "../lib/recent-files";
import { IconClose } from "./Icon";
import { useOverlayLock } from "../hooks/useOverlayLock";
import { useFocusTrap } from "../hooks/useFocusTrap";
import {
  isTopOverlayLayer,
  popOverlayLayer,
  pushOverlayLayer,
} from "../lib/overlay-state";

interface LibraryDrawerProps {
  open: boolean;
  onClose: () => void;
  recentFiles: RecentFile[];
  sessions: StoredChatSession[];
  activePath: string | null;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onOpenSession: (path: string, sessionId?: string) => void;
  onClearSession: (path: string) => void;
  onOpenFile: () => void;
}

export function LibraryDrawer({
  open,
  onClose,
  recentFiles,
  sessions,
  activePath,
  onOpenRecent,
  onRemoveRecent,
  onOpenSession,
  onClearSession,
  onOpenFile,
}: LibraryDrawerProps) {
  const { t } = useI18n();
  useOverlayLock(open);
  const panelRef = useRef<HTMLElement>(null);
  useFocusTrap(open, panelRef);

  useEffect(() => {
    if (!open) return;
    const layerId = pushOverlayLayer();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopOverlayLayer(layerId)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      popOverlayLayer(layerId);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="library-drawer-root" role="presentation">
      <button type="button" className="library-drawer-backdrop" onClick={onClose} aria-label={t("library.close")} />
      <aside ref={panelRef} className="library-drawer" role="dialog" aria-modal="true" aria-label={t("sidebar.library")}>
        <header className="library-drawer-header">
          <h2>{t("sidebar.library")}</h2>
          <button type="button" className="btn icon-btn" onClick={onClose} aria-label={t("library.close")}>
            <IconClose size={14} />
          </button>
        </header>
        <button type="button" className="btn primary library-drawer-open" onClick={onOpenFile}>
          {t("sidebar.openDocument")}
        </button>
        <div className="library-drawer-body">
          <DocumentLibrary
            recentFiles={recentFiles}
            sessions={sessions}
            activePath={activePath}
            onOpenRecent={(path) => {
              onOpenRecent(path);
              onClose();
            }}
            onRemoveRecent={onRemoveRecent}
            onOpenSession={(path, sessionId) => {
              onOpenSession(path, sessionId);
              onClose();
            }}
            onClearSession={onClearSession}
          />
        </div>
      </aside>
    </div>
  );
}
