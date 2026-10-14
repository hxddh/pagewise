import { useI18n } from "../i18n";
import { StatusLine } from "./ui/StatusLine";

interface FileErrorBannerProps {
  message: string;
  onDismiss: () => void;
}

/**
 * The one surface a failed document open is reported through.
 *
 * It stays rather than going past (the toast in the same corner was removed for
 * exactly this reason — see `css-hygiene.test.mjs`), so it is a `banner`: a
 * state the reader is left sitting in, with the one control that clears it.
 */
export function FileErrorBanner({ message, onDismiss }: FileErrorBannerProps) {
  const { t } = useI18n();

  return (
    <StatusLine
      role="banner"
      tone="error"
      className="file-error-banner"
      message={message}
      onDismiss={onDismiss}
      dismissLabel={t("common.dismiss")}
    />
  );
}
