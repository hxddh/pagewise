import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { useTheme } from "../../hooks/useTheme";
import {
  AUTO_INDEX_PAGE_CHOICES,
  loadPreferences,
  patchPreferences,
  type LocaleMode,
  type PreviewQuality,
} from "../../lib/preferences";
import { clearIndexCache, getIndexCacheStats, type IndexCacheStats } from "../../lib/index-store";
import { setAutoIndexCap } from "../../document/index-queue";

interface GeneralSettingsProps {
  followAgentDefault: boolean;
  onFollowAgentDefaultChange: (value: boolean) => void;
  includeViewingPageDefault: boolean;
  onIncludeViewingPageDefaultChange: (value: boolean) => void;
  onPreferencesSaved?: () => Promise<void>;
}

function PillRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
}) {
  return (
    <div className="settings-pill-row">
      <span className="settings-pill-row-label">{label}</span>
      <div className="settings-pill-group" role="group" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={`settings-pill ${value === opt.id ? "active" : ""}`}
            onClick={() => onChange(opt.id)}
            aria-pressed={value === opt.id}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function GeneralSettings({
  followAgentDefault,
  onFollowAgentDefaultChange,
  includeViewingPageDefault,
  onIncludeViewingPageDefaultChange,
  onPreferencesSaved,
}: GeneralSettingsProps) {
  const { t, localeMode, setLocaleMode } = useI18n();
  const { theme, setTheme } = useTheme();
  const [previewQuality, setPreviewQuality] = useState<PreviewQuality>("auto");
  const [localFollowAgent, setLocalFollowAgent] = useState(followAgentDefault);
  const [localIncludeViewingPage, setLocalIncludeViewingPage] = useState(
    includeViewingPageDefault,
  );
  const [autoIndexPages, setAutoIndexPages] = useState<number | null>(null);
  const [cacheStats, setCacheStats] = useState<IndexCacheStats | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

  useEffect(() => {
    loadPreferences().then((p) => {
      setPreviewQuality(p.previewQuality);
      setLocalFollowAgent(p.followAgentDefault);
      setLocalIncludeViewingPage(p.includeViewingPageDefault);
      setAutoIndexPages(p.autoIndexPages);
    });
  }, []);

  useEffect(() => {
    let alive = true;
    // Stats are best-effort: a failed read leaves the row on its placeholder
    // rather than breaking the settings page.
    getIndexCacheStats()
      .then((stats) => {
        if (alive) setCacheStats(stats);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function onAutoIndexPages(next: number) {
    setAutoIndexPages(next);
    // Push into the queue immediately — the sweep budget is read synchronously
    // when a document schedules its pages.
    setAutoIndexCap(next);
    await patchPreferences({ autoIndexPages: next });
    await onPreferencesSaved?.();
  }

  async function onClearCache() {
    setClearingCache(true);
    try {
      await clearIndexCache();
      setCacheStats({ docs: 0, pages: 0, chars: 0 });
    } finally {
      setClearingCache(false);
    }
  }

  async function onFollowChange(checked: boolean) {
    setLocalFollowAgent(checked);
    onFollowAgentDefaultChange(checked);
    await patchPreferences({ followAgentDefault: checked });
  }

  async function onIncludeViewingPageChange(checked: boolean) {
    setLocalIncludeViewingPage(checked);
    onIncludeViewingPageDefaultChange(checked);
    await patchPreferences({ includeViewingPageDefault: checked });
  }

  async function onPreviewQuality(next: PreviewQuality) {
    setPreviewQuality(next);
    await patchPreferences({ previewQuality: next });
    await onPreferencesSaved?.();
  }

  return (
    <div className="settings-page">
      <h3 className="settings-page-title">{t("settings.general")}</h3>

      <section className="settings-card">
        <h4 className="settings-card-title">{t("settings.appearanceAndLanguage")}</h4>
        <PillRow
          label={t("settings.appearance")}
          value={theme}
          options={[
            { id: "dark", label: t("settings.themeDark") },
            { id: "light", label: t("settings.themeLight") },
            { id: "system", label: t("settings.themeSystem") },
          ]}
          onChange={(id) => void setTheme(id)}
        />
        <PillRow
          label={t("settings.language")}
          value={localeMode}
          options={[
            { id: "system", label: t("settings.langSystem") },
            { id: "en", label: t("settings.langEn") },
            { id: "zh-CN", label: t("settings.langZh") },
          ]}
          onChange={(id) => void setLocaleMode(id as LocaleMode)}
        />
      </section>

      <section className="settings-card">
        <h4 className="settings-card-title">{t("settings.documentAndAgent")}</h4>
        <PillRow
          label={t("settings.previewQuality")}
          value={previewQuality}
          options={[
            { id: "auto", label: t("settings.qualityAuto") },
            { id: "crisp", label: t("settings.qualityCrisp") },
            { id: "performance", label: t("settings.qualityPerformance") },
          ]}
          onChange={(id) => void onPreviewQuality(id as PreviewQuality)}
        />
        <div className="settings-card-divider" />
        <label className="settings-row-toggle">
          <div>
            <span className="settings-row-title">{t("settings.includeViewingPage")}</span>
            <span className="settings-row-hint">{t("settings.includeViewingPageHint")}</span>
          </div>
          <input
            type="checkbox"
            checked={localIncludeViewingPage}
            onChange={(e) => void onIncludeViewingPageChange(e.target.checked)}
          />
        </label>
        <label className="settings-row-toggle">
          <div>
            <span className="settings-row-title">{t("settings.followAgentDefault")}</span>
            <span className="settings-row-hint">{t("settings.followAgentHint")}</span>
          </div>
          <input
            type="checkbox"
            checked={localFollowAgent}
            onChange={(e) => void onFollowChange(e.target.checked)}
          />
        </label>
      </section>

      <section className="settings-card">
        <h4 className="settings-card-title">{t("settings.scanning")}</h4>
        <PillRow
          label={t("settings.autoScanBudget")}
          value={String(autoIndexPages ?? "")}
          options={AUTO_INDEX_PAGE_CHOICES.map((pages) => ({
            id: String(pages),
            label: pages === 0 ? t("settings.autoScanOff") : String(pages),
          }))}
          onChange={(id) => void onAutoIndexPages(Number(id))}
        />
        <span className="settings-row-hint">{t("settings.autoScanHint")}</span>
        <div className="settings-card-divider" />
        <div className="settings-row-toggle">
          <div>
            <span className="settings-row-title">{t("settings.scanCache")}</span>
            <span className="settings-row-hint">
              {cacheStats === null
                ? t("settings.scanCacheLoading")
                : cacheStats.pages === 0
                  ? t("settings.scanCacheEmpty")
                  : t("settings.scanCacheStats", {
                      docs: cacheStats.docs,
                      pages: cacheStats.pages,
                      size: formatChars(cacheStats.chars),
                    })}
            </span>
          </div>
          <button
            type="button"
            className="btn ghost"
            disabled={clearingCache || !cacheStats || cacheStats.pages === 0}
            onClick={() => void onClearCache()}
          >
            {clearingCache ? t("settings.scanCacheClearing") : t("settings.scanCacheClear")}
          </button>
        </div>
      </section>
    </div>
  );
}

/** Approximate on-disk footprint; stored text is UTF-16 in memory, ~1 byte/char as JSON ASCII. */
function formatChars(chars: number): string {
  const kb = chars / 1024;
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
