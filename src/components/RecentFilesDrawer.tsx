import { memo, useCallback } from "react";
import { X } from "lucide-react";
import { useI18n } from "../i18n";
import type { RecentFile } from "../lib/recent-files";
import { RecentFilesList } from "./RecentFilesList";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

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

  const requestClose = useCallback(() => onClose(), [onClose]);

  const handleOpenRecent = (path: string) => {
    onClose();
    onOpenRecent(path);
  };

  return (
    <Modal
      open={open}
      onClose={requestClose}
      overlayClassName="library-drawer-root"
      className="library-drawer"
      ariaLabel={t("sidebar.library")}
    >
      <header className="library-drawer-header">
        <h2>{t("sidebar.library")}</h2>
        <Button
          variant="ghost" size="md" icon
          onClick={requestClose}
          aria-label={t("library.close")}
        >
          <X size={16} />
        </Button>
      </header>

      <Button
        variant="primary" size="md" className="library-drawer-open"
        onClick={() => {
          onClose();
          onOpenFile();
        }}
        disabled={opening}
      >
        {opening ? t("sidebar.opening") : t("sidebar.openDocument")}
      </Button>

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
    </Modal>
  );
}

export const RecentFilesDrawer = memo(RecentFilesDrawerInner);
