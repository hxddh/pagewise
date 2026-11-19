import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "../../i18n";
import { APP_VERSION_FALLBACK, resolveAppVersion } from "../../lib/app-version";
import { issueUrl, platformName } from "../../lib/report-issue";
import { LogoMark } from "../LogoMark";
import { Button } from "../ui/Button";

const GITHUB_URL = "https://github.com/hxddh/pagewise";
const LATEST_RELEASE_API = "https://api.github.com/repos/hxddh/pagewise/releases/latest";

function isNewerSemver(latestTag: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(latestTag);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "upToDate" }
  | { status: "available"; version: string; url: string }
  | { status: "failed" };

export function AboutSettings() {
  const { t, locale } = useI18n();
  const [appVersion, setAppVersion] = useState(APP_VERSION_FALLBACK);
  const [update, setUpdate] = useState<UpdateState>({ status: "idle" });

  useEffect(() => {
    void resolveAppVersion().then(setAppVersion);
  }, []);

  async function checkForUpdates() {
    setUpdate({ status: "checking" });
    try {
      const res = await fetch(LATEST_RELEASE_API, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
      const tag = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
      const htmlUrl =
        typeof data.html_url === "string" && data.html_url.startsWith("https://")
          ? data.html_url
          : `${GITHUB_URL}/releases/latest`;
      if (tag && isNewerSemver(tag, appVersion)) {
        setUpdate({ status: "available", version: tag.replace(/^v/i, ""), url: htmlUrl });
      } else {
        setUpdate({ status: "upToDate" });
      }
    } catch {
      setUpdate({ status: "failed" });
    }
  }

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
            <span className="settings-info-label">
              {update.status === "upToDate"
                ? t("settings.updateUpToDate")
                : update.status === "available"
                  ? t("settings.updateAvailable", { version: update.version })
                  : update.status === "failed"
                    ? t("settings.updateFailed")
                    : t("settings.updates")}
            </span>
            {update.status === "available" ? (
              <a
                className="settings-info-link"
                href={update.url}
                onClick={(e) => {
                  e.preventDefault();
                  void openUrl(update.url);
                }}
              >
                {t("settings.updateDownload")}
              </a>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={update.status === "checking"}
                onClick={() => void checkForUpdates()}
              >
                {update.status === "checking"
                  ? t("settings.updateChecking")
                  : t("settings.checkForUpdates")}
              </Button>
            )}
          </div>
          <div className="settings-info-row">
            <span className="settings-info-label">{t("settings.github")}</span>
            <a className="settings-info-link" href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>
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
