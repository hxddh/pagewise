import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n";
import { APP_VERSION_FALLBACK, resolveAppVersion } from "../../lib/app-version";
import { issueUrl, platformName } from "../../lib/report-issue";
import { LogoMark } from "../LogoMark";

const GITHUB_URL = "https://github.com/hxddh/pagewise";

export function AboutSettings() {
  const { t, locale } = useI18n();
  const [appVersion, setAppVersion] = useState(APP_VERSION_FALLBACK);

  useEffect(() => {
    void resolveAppVersion().then(setAppVersion);
  }, []);

  return (
    <div className="settings-page">
      <h3 className="settings-page-title">{t("settings.about")}</h3>

      <section className="settings-card">
        <div className="about-brand-row">
          <div className="about-logo">
            <LogoMark size={20} />
          </div>
          <div>
            <span className="about-brand-name">PageWise</span>
            <span className="about-brand-version">
              {t("settings.version")} {appVersion}
            </span>
          </div>
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-info-rows">
          <div className="settings-info-row">
            <span className="settings-info-label">{t("settings.github")}</span>
            <a className="settings-info-link" href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
          {/* The way back (v23): version, platform and language, nothing from a document. */}
          <div className="settings-info-row">
            <span className="settings-info-label">{t("settings.reportProblem")}</span>
            <a
              className="settings-info-link"
              href={issueUrl({ version: appVersion, platform: platformName(navigator.userAgent), locale })}
              onClick={(e) => {
                e.preventDefault();
                void openUrl(e.currentTarget.href);
              }}
            >
              {t("settings.reportProblemAction")}
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
