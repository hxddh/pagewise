import { memo } from "react";
import { FileImage, FileText } from "lucide-react";
import { useI18n } from "../i18n";
import type { RecentFile } from "../lib/recent-files";

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

interface RecentFilesListProps {
  files: RecentFile[];
  layout: "welcome" | "drawer";
  limit?: number;
  activePath?: string | null;
  opening?: boolean;
  onOpen: (path: string) => void;
  onRemove?: (path: string) => void;
}

function RecentFilesListInner({
  files,
  layout,
  limit,
  activePath = null,
  opening = false,
  onOpen,
  onRemove,
}: RecentFilesListProps) {
  const { t } = useI18n();
  const items = limit != null ? files.slice(0, limit) : files;

  if (layout === "welcome") {
    if (items.length === 0) return null;
    return (
      <div className="welcome-recents">
        <h3 className="welcome-recents-label">{t("sidebar.recent")}</h3>
        <div className="welcome-recent-grid">
          {items.map((file) => {
            const Icon = file.kind === "image" ? FileImage : FileText;
            return (
              <button
                key={file.path}
                type="button"
                className="welcome-recent-card"
                disabled={opening}
                onClick={() => onOpen(file.path)}
              >
                <Icon size={20} strokeWidth={1.5} className="welcome-recent-icon" />
                <span className="welcome-recent-name">{file.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="library-empty">
        <p>{t("library.emptyRecent")}</p>
        <p>{t("library.emptyRecentHint")}</p>
      </div>
    );
  }

  return (
    <ul className="library-list">
      {items.map((file) => {
        const active = file.path === activePath;
        const Icon = file.kind === "image" ? FileImage : FileText;
        return (
          <li key={file.path} className={active ? "active" : undefined}>
            <button
              type="button"
              className="library-item library-item-history"
              onClick={() => onOpen(file.path)}
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
            {onRemove && (
              <button
                type="button"
                className="library-remove"
                aria-label={t("library.remove")}
                title={t("library.remove")}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(file.path);
                }}
              >
                ×
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export const RecentFilesList = memo(RecentFilesListInner);
