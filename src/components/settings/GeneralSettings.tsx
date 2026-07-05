import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { useTheme } from "../../hooks/useTheme";
import {
  loadPreferences,
  patchPreferences,
  type LocaleMode,
  type PreviewQuality,
} from "../../lib/preferences";

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

  useEffect(() => {
    loadPreferences().then((p) => {
      setPreviewQuality(p.previewQuality);
      setLocalFollowAgent(p.followAgentDefault);
      setLocalIncludeViewingPage(p.includeViewingPageDefault);
    });
  }, []);

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
    </div>
  );
}
