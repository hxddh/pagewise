import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import { APP_VERSION_FALLBACK, resolveAppVersion } from "../../lib/app-version";
import { LogoMark } from "../LogoMark";

const GITHUB_URL = "https://github.com/hxddh/pagewise";

export function AboutSettings() {
  const { t } = useI18n();
  const [appVersion, setAppVersion] = useState(APP_VERSION_FALLBACK);
  const [tesseractOk, setTesseractOk] = useState<boolean | null>(null);

  useEffect(() => {
    void resolveAppVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    invoke<{ installed: boolean; chi_sim: boolean }>("check_tesseract")
      .then((status) => setTesseractOk(status.installed))
      .catch(() => setTesseractOk(false));
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
            <span className="settings-info-label">{t("settings.tesseract")}</span>
            <span
              className={`settings-info-value ${tesseractOk ? "ok" : tesseractOk === false ? "warn" : ""}`}
            >
              {tesseractOk === null
                ? "…"
                : tesseractOk
                  ? t("settings.tesseractOk")
                  : t("settings.tesseractMissing")}
            </span>
          </div>
          <div className="settings-info-row">
            <span className="settings-info-label">{t("settings.github")}</span>
            <a className="settings-info-link" href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
