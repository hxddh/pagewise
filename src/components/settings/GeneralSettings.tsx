import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { useTheme } from "../../hooks/useTheme";
import {
  AGENT_SCAN_PAGE_CHOICES,
  AUTO_INDEX_PAGE_CHOICES,
  loadPreferences,
  patchPreferences,
  resolveOcrLanguages,
  type LocaleMode,
} from "../../lib/preferences";
import { clearIndexCache, getIndexCacheStats, type IndexCacheStats } from "../../lib/index-store";
import { setAgentScanCap, setAutoIndexCap } from "../../document/index-queue";
import { configureOcr } from "../../lib/ocr/ocr-service";
import { clearOcrCache, getOcrCacheStats } from "../../lib/ocr/ocr-store";
import { Button } from "../ui/Button";

interface GeneralSettingsProps {
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
          // raw-button: a segment of a segmented control; the group is the control, not each pill
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
  includeViewingPageDefault,
  onIncludeViewingPageDefaultChange,
  onPreferencesSaved,
}: GeneralSettingsProps) {
  const { t, localeMode, setLocaleMode } = useI18n();
  const { theme, setTheme } = useTheme();
  const [localIncludeViewingPage, setLocalIncludeViewingPage] = useState(
    includeViewingPageDefault,
  );
  const [autoIndexPages, setAutoIndexPages] = useState<number | null>(null);
  const [cacheStats, setCacheStats] = useState<IndexCacheStats | null>(null);
  const [localOcr, setLocalOcr] = useState<boolean | null>(null);
  const [ocrStats, setOcrStats] = useState<{ bytes: number; docs: number } | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

  useEffect(() => {
    loadPreferences().then((p) => {
      setLocalIncludeViewingPage(p.includeViewingPageDefault);
      setAutoIndexPages(p.autoIndexPages);
      setLocalOcr(p.localOcr);
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void getOcrCacheStats().then((stats) => {
      if (alive) setOcrStats(stats);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function onLocalOcr(next: boolean) {
    setLocalOcr(next);
    const p = await patchPreferences({ localOcr: next });
    configureOcr({ enabled: p.localOcr, languages: resolveOcrLanguages(p) });
    await onPreferencesSaved?.();
  }

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

  /**
   * One control for reading pages in the cloud (16.0): how many pages of a
   * document may be read in the background, and — at the same step — how many
   * the assistant may send while answering one question. Two settings that
   * always moved together are one.
   */
  async function onCloudReading(next: number) {
    const step = Math.max(0, AUTO_INDEX_PAGE_CHOICES.indexOf(next as (typeof AUTO_INDEX_PAGE_CHOICES)[number]));
    const agent = AGENT_SCAN_PAGE_CHOICES[step] ?? 0;
    setAutoIndexPages(next);
    // Pushed into the queue at once — the sweep budget is read synchronously
    // when a document schedules its pages.
    setAutoIndexCap(next);
    setAgentScanCap(agent);
    await patchPreferences({ autoIndexPages: next, agentScanPages: agent });
    await onPreferencesSaved?.();
  }

  /** Both stores of text read from pages — by OCR and by the cloud — cleared together. */
  async function onClearCache() {
    setClearingCache(true);
    try {
      await Promise.all([clearIndexCache(), clearOcrCache()]);
      setCacheStats({ docs: 0, pages: 0, chars: 0 });
      setOcrStats({ bytes: 0, docs: 0 });
    } finally {
      setClearingCache(false);
    }
  }

  async function onIncludeViewingPageChange(checked: boolean) {
    setLocalIncludeViewingPage(checked);
    onIncludeViewingPageDefaultChange(checked);
    await patchPreferences({ includeViewingPageDefault: checked });
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
      </section>

      <section className="settings-card">
        <h4 className="settings-card-title">{t("settings.scanning")}</h4>
        <label className="settings-row-toggle">
          <div>
            <span className="settings-row-title">{t("settings.localOcr")}</span>
            <span className="settings-row-hint">{t("settings.localOcrHint")}</span>
          </div>
          <input
            type="checkbox"
            checked={localOcr ?? true}
            disabled={localOcr === null}
            onChange={(e) => void onLocalOcr(e.target.checked)}
          />
        </label>
        <div className="settings-card-divider" />
        <PillRow
          label={t("settings.cloudReading")}
          value={String(autoIndexPages ?? "")}
          options={AUTO_INDEX_PAGE_CHOICES.map((pages) => ({
            id: String(pages),
            label: pages === 0 ? t("settings.autoScanOff") : String(pages),
          }))}
          onChange={(id) => void onCloudReading(Number(id))}
        />
        <span className="settings-row-hint">{t("settings.cloudReadingHint")}</span>
        <div className="settings-card-divider" />
        <div className="settings-row-toggle">
          <div>
            <span className="settings-row-title">{t("settings.readPagesCache")}</span>
            <span className="settings-row-hint">
              {cacheStats === null || ocrStats === null
                ? t("settings.scanCacheLoading")
                : cacheStats.pages === 0 && ocrStats.docs === 0
                  ? t("settings.scanCacheEmpty")
                  : t("settings.readPagesCacheStats", {
                      docs: Math.max(cacheStats.docs, ocrStats.docs),
                      size: formatChars(cacheStats.chars + ocrStats.bytes),
                    })}
            </span>
          </div>
          <Button
            variant="ghost" size="md"
            disabled={clearingCache || !cacheStats || !ocrStats || (cacheStats.pages === 0 && ocrStats.docs === 0)}
            onClick={() => void onClearCache()}
          >
            {clearingCache ? t("settings.scanCacheClearing") : t("settings.scanCacheClear")}
          </Button>
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
