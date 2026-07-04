import { useI18n } from "../../i18n";

export function SettingsSkeleton() {
  const { t } = useI18n();

  return (
    <div
      className="settings-skeleton-page"
      aria-busy="true"
      aria-label={t("settings.loading")}
    >
      <div className="settings-skeleton-line w35" />
      <div className="settings-skeleton-card">
        <div className="settings-skeleton-line w60" />
        <div className="settings-skeleton-grid">
          <div className="settings-skeleton-cell" />
          <div className="settings-skeleton-cell" />
          <div className="settings-skeleton-cell" />
          <div className="settings-skeleton-cell" />
        </div>
      </div>
      <div className="settings-skeleton-card">
        <div className="settings-skeleton-line w35" />
        <div className="settings-skeleton-field" />
      </div>
      <div className="settings-skeleton-card">
        <div className="settings-skeleton-line w35" />
        <div className="settings-skeleton-field" />
      </div>
    </div>
  );
}
