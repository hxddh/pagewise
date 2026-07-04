import { FolderOpen, Settings } from "lucide-react";
import { useI18n } from "../i18n";
import { IconDot } from "./Icon";
import { LogoMark } from "./LogoMark";

interface AppRailProps {
  libraryOpen: boolean;
  onLibrary: () => void;
  onOpenFile: () => void;
  onSettings: () => void;
  connected: boolean;
  opening?: boolean;
}

export function AppRail({
  libraryOpen,
  onLibrary,
  onOpenFile,
  onSettings,
  connected,
  opening,
}: AppRailProps) {
  const { t } = useI18n();

  return (
    <nav className="app-rail" aria-label={t("workbench.nav")}>
      <div className="app-rail-brand" title={t("app.name")}>
        <LogoMark size={22} className="app-rail-logo" />
      </div>

      <div className="app-rail-actions">
        <button
          type="button"
          className={`rail-btn ${libraryOpen ? "active" : ""}`}
          onClick={onLibrary}
          title={t("sidebar.library")}
          aria-label={t("sidebar.library")}
        >
          <FolderOpen size={18} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          className="rail-btn rail-btn-accent"
          onClick={onOpenFile}
          disabled={opening}
          title={t("sidebar.openDocument")}
          aria-label={t("sidebar.openDocument")}
        >
          <span className="rail-btn-label">+</span>
        </button>
      </div>

      <button
        type="button"
        className="rail-btn rail-btn-bottom"
        onClick={onSettings}
        title={
          connected ? t("sidebar.connected") : t("sidebar.settingsHint")
        }
        aria-label={
          connected ? t("sidebar.connected") : t("sidebar.notConfigured")
        }
      >
        <Settings size={18} strokeWidth={1.75} />
        <IconDot connected={connected} />
      </button>
    </nav>
  );
}
