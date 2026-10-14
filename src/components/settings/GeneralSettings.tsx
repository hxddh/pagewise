import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { useTheme } from "../../hooks/useTheme";
import {
  AGENT_SCAN_PAGE_CHOICES,
  AUTO_INDEX_PAGE_CHOICES,
  READING_SCALE_CHOICES,
  applyReadingScale,
  loadPreferences,
  patchPreferences,
  resolveOcrLanguages,
  type LocaleMode,
} from "../../lib/preferences";
import { setAgentScanCap, setAutoIndexCap } from "../../document/index-queue";
import { configureOcr } from "../../lib/ocr/ocr-service";
import { AssistantSettings } from "./AssistantSettings";

/**
 * Everything a reader can change, in three groups.
 *
 * 18.0 collapsed the old "General" and "AI Provider" tabs into one surface:
 * appearance, how the app reads pages, and the assistant. The AI tab's
 * paragraph-long explanations are gone with it — a row is a title, a one-line
 * caption, and the control. Anything that needs an explanation the caption
 * cannot carry (endpoints, scan models, thinking) lives in the assistant's
 * Advanced disclosure instead of on the everyday surface.
 */
interface GeneralSettingsProps {
  includeViewingPageDefault: boolean;
  onIncludeViewingPageDefaultChange: (value: boolean) => void;
  /** Reading follows the assistant: a preference, set from the Reading group. */
  followAgentDefault: boolean;
  onFollowAgentDefaultChange: (value: boolean) => void;
  /** Read every page that still has no text (the whole-document scan). */
  onScanAllPages?: () => void;
  onPreferencesSaved?: () => Promise<void>;
  onLlmSettingsSaved?: () => void;
  onReindexDoc?: () => void;
  onApiReady?: () => void;
  onTestResult?: (message: string, ok: boolean) => void;
  onSaveError?: () => void;
  onRefreshConnection?: () => void;
}

/**
 * The cloud-pages row, in words: Off / Auto / All (19.0).
 *
 * It was four numbers — 0, 20, 50, 200 — which asked the reader to hold a
 * table in their head, and 50 and 200 both meant "a lot". All is the
 * whole-document scan: it sets the widest budget and asks for confirmation the
 * way the old scan-all command did, because every page it cannot read locally
 * is a billed call.
 */
const CLOUD_READING_LABELS = [
  "settings.autoScanOff",
  "settings.autoScanAuto",
  "settings.autoScanAll",
] as const;

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
  followAgentDefault,
  onFollowAgentDefaultChange,
  onScanAllPages,
  onPreferencesSaved,
  onLlmSettingsSaved,
  onReindexDoc,
  onApiReady,
  onTestResult,
  onSaveError,
  onRefreshConnection,
}: GeneralSettingsProps) {
  const { t, localeMode, setLocaleMode } = useI18n();
  const { theme, setTheme } = useTheme();
  const [autoIndexPages, setAutoIndexPages] = useState<number | null>(null);
  const [readingScale, setReadingScale] = useState<number | null>(null);
  const [showUsageLine, setShowUsageLine] = useState(true);
  const [localOcr, setLocalOcr] = useState<boolean | null>(null);

  useEffect(() => {
    void loadPreferences().then((p) => {
      setAutoIndexPages(p.autoIndexPages);
      setLocalOcr(p.localOcr);
      setReadingScale(p.readingScale);
      setShowUsageLine(p.showUsageLine);
    });
  }, []);

  async function onLocalOcr(next: boolean) {
    setLocalOcr(next);
    const p = await patchPreferences({ localOcr: next });
    configureOcr({ enabled: p.localOcr, languages: resolveOcrLanguages(p) });
    await onPreferencesSaved?.();
  }

  /**
   * One control for reading pages in the cloud: how many pages of a document
   * may be read in the background, and — at the same step — how many the
   * assistant may send while answering one question. Two settings that always
   * moved together are one.
   *
   * `All` is the whole-document scan: the standing budget and the action the
   * reader asked for are one click, and the confirmation is where the bill is
   * agreed to. The composer banner keeps its own scan-all action: that one is
   * the contextual remedy, shown when a document turns out to have unscanned
   * pages, and it is not a setting.
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
    if (next === AUTO_INDEX_PAGE_CHOICES[AUTO_INDEX_PAGE_CHOICES.length - 1]) onScanAllPages?.();
  }

  async function onReadingScale(next: number) {
    setReadingScale(next);
    applyReadingScale(next);
    await patchPreferences({ readingScale: next });
    await onPreferencesSaved?.();
  }

  async function onShowUsageLine(next: boolean) {
    setShowUsageLine(next);
    await patchPreferences({ showUsageLine: next });
    await onPreferencesSaved?.();
  }

  return (
    <div className="settings-page">
      <h3 className="settings-page-title">{t("settings.general")}</h3>

      <section className="settings-card">
        <h4 className="settings-card-title">{t("settings.appearanceGroup")}</h4>
        <PillRow
          label={t("settings.appearance")}
          value={theme}
          options={[
            { id: "dark", label: t("settings.themeDark") },
            { id: "light", label: t("settings.themeLight") },
            { id: "paper", label: t("settings.themePaper") },
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
        <h4 className="settings-card-title">{t("settings.readingGroup")}</h4>
        <PillRow
          label={t("settings.readingScale")}
          value={String(readingScale ?? 1)}
          options={READING_SCALE_CHOICES.map((scale) => ({
            id: String(scale),
            label:
              scale < 1
                ? t("settings.readingScaleSmall")
                : scale > 1
                  ? t("settings.readingScaleLarge")
                  : t("settings.readingScaleDefault"),
          }))}
          onChange={(id) => void onReadingScale(Number(id))}
        />
        <label className="settings-row-toggle">
          <div>
            <span className="settings-row-title">{t("settings.followAgent")}</span>
            <span className="settings-row-hint">{t("settings.followAgentHint")}</span>
          </div>
          <input
            type="checkbox"
            checked={followAgentDefault}
            onChange={(e) => void onFollowAgentDefaultChange(e.target.checked)}
          />
        </label>
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
          options={AUTO_INDEX_PAGE_CHOICES.map((pages, step) => ({
            id: String(pages),
            label: t(CLOUD_READING_LABELS[step] ?? "settings.autoScanAuto"),
          }))}
          onChange={(id) => void onCloudReading(Number(id))}
        />
      </section>

      <AssistantSettings
        onLlmSettingsSaved={onLlmSettingsSaved}
        onReindexDoc={onReindexDoc}
        onApiReady={onApiReady}
        onTestResult={onTestResult}
        onSaveError={onSaveError}
        onRefreshConnection={onRefreshConnection}
        includeViewingPageDefault={includeViewingPageDefault}
        onIncludeViewingPageDefaultChange={onIncludeViewingPageDefaultChange}
        showUsageLine={showUsageLine}
        onShowUsageLineChange={(value) => void onShowUsageLine(value)}
      />
    </div>
  );
}
