import { memo } from "react";
import { useI18n } from "../i18n";
import { LogoMark } from "./LogoMark";
import { RecentFilesList } from "./RecentFilesList";
import type { RecentFile } from "../lib/recent-files";

interface WelcomeViewProps {
  recentFiles: RecentFile[];
  canUseAgent: boolean;
  hasApiKey?: boolean;
  agentToolsSupported?: boolean;
  opening?: boolean;
  onOpenFile: () => void;
  onOpenRecent: (path: string) => void;
  onConfigureApi: () => void;
}

function WelcomeViewInner({
  recentFiles,
  canUseAgent,
  hasApiKey = false,
  agentToolsSupported = true,
  opening,
  onOpenFile,
  onOpenRecent,
  onConfigureApi,
}: WelcomeViewProps) {
  const { t } = useI18n();

  return (
    <div className="welcome-view">
      <div className="welcome-inner">
        <div className="welcome-brand">
          <LogoMark size={40} className="welcome-logo" />
          <h1 className="welcome-title">{t("welcome.title")}</h1>
          <p className="welcome-app-name">{t("app.name")}</p>
        </div>
        <p className="welcome-subtitle">{t("welcome.subtitle")}</p>

        <button
          type="button"
          className="btn primary welcome-open-btn"
          onClick={onOpenFile}
          disabled={opening}
        >
          {opening ? t("sidebar.opening") : t("sidebar.openDocument")}
        </button>
        <p className="welcome-drop-hint">{t("preview.dropHintShort")}</p>

        {!canUseAgent && (
          <p className="welcome-api-hint">
            {hasApiKey && !agentToolsSupported
              ? t("welcome.toolsHint")
              : t("welcome.apiHint")}{" "}
            <button type="button" className="link-btn" onClick={onConfigureApi}>
              {t("empty.configureInline")}
            </button>
          </p>
        )}

        <RecentFilesList
          files={recentFiles}
          layout="welcome"
          limit={3}
          opening={opening}
          onOpen={onOpenRecent}
        />
      </div>
    </div>
  );
}

export const WelcomeView = memo(WelcomeViewInner);
