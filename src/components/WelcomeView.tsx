import { memo } from "react";
import { useI18n } from "../i18n";
import { LogoMark } from "./LogoMark";
import { RecentFilesList } from "./RecentFilesList";
import type { RecentFile } from "../lib/recent-files";
import { Button } from "./ui/Button";

interface WelcomeViewProps {
  recentFiles: RecentFile[];
  canUseAgent: boolean;
  hasApiKey?: boolean;
  agentToolsSupported?: boolean;
  opening?: boolean;
  onOpenFile: () => void;
  onOpenSample?: () => void;
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
  onOpenSample,
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
        </div>
        <p className="welcome-subtitle">{t(canUseAgent ? "welcome.subtitleReady" : "welcome.subtitle")}</p>

        <div className="welcome-actions">
          <Button
            variant="primary"
            size="lg"
            className="welcome-open-btn"
            onClick={onOpenFile}
            disabled={opening}
          >
            {opening ? t("sidebar.opening") : t("sidebar.openDocument")}
          </Button>
          {onOpenSample && (
            <Button
              variant="secondary"
              size="lg"
              className="welcome-sample-btn"
              onClick={onOpenSample}
              disabled={opening}
            >
              {t("welcome.trySample")}
            </Button>
          )}
        </div>
        <p className="welcome-drop-hint">{t("preview.dropHintShort")}</p>

        {!canUseAgent && (
          <p className="welcome-api-hint">
            {hasApiKey && !agentToolsSupported
              ? t("welcome.toolsHint")
              : t("welcome.apiHint")}{" "}
            <Button variant="link" size="md" onClick={onConfigureApi}>
              {t("empty.configureInline")}
            </Button>
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
