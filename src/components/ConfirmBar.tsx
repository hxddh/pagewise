import { useI18n } from "../i18n";

interface ConfirmBarProps {
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmBar({
  message,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmBarProps) {
  const { t } = useI18n();
  const cancel = cancelLabel ?? t("common.cancel");

  return (
    <div className="confirm-bar" role="alertdialog" aria-live="assertive">
      <p className="confirm-bar-message">{message}</p>
      <div className="confirm-bar-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          {cancel}
        </button>
        <button
          type="button"
          className={`btn ${danger ? "danger-btn" : "primary"}`}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
