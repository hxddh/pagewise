import { useI18n } from "../i18n";
import { Button } from "./ui/Button";

interface FileErrorBannerProps {
  message: string;
  onDismiss: () => void;
}

export function FileErrorBanner({ message, onDismiss }: FileErrorBannerProps) {
  const { t } = useI18n();

  return (
    <div className="file-error-banner" role="alert">
      <span>{message}</span>
      <Button variant="ghost" size="md" icon className="file-error-dismiss" onClick={onDismiss} aria-label={t("common.dismiss")}>
        ×
      </Button>
    </div>
  );
}
