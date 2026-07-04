import { useI18n } from "../i18n";

interface FileErrorBannerProps {
  message: string;
  onDismiss: () => void;
}

export function FileErrorBanner({ message, onDismiss }: FileErrorBannerProps) {
  const { t } = useI18n();

  return (
    <div className="file-error-banner" role="alert">
      <span>{message}</span>
      <button type="button" className="btn ghost file-error-dismiss" onClick={onDismiss} aria-label={t("common.dismiss")}>
        ×
      </button>
    </div>
  );
}
