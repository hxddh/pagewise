import { useI18n } from "../i18n";

interface DropOverlayProps {
  visible: boolean;
}

export function DropOverlay({ visible }: DropOverlayProps) {
  const { t } = useI18n();
  if (!visible) return null;

  return (
    <div className="drop-overlay" role="dialog" aria-modal="true" aria-label={t("drop.title")}>
      <div className="drop-overlay-inner">
        <p className="drop-title">{t("drop.title")}</p>
        <p className="drop-hint">{t("drop.hint")}</p>
      </div>
    </div>
  );
}
