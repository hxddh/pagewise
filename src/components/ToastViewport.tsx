import { useI18n } from "../i18n";
import { useToast, type Toast } from "../hooks/useToast";

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <div
      className={`toast toast-${toast.tone ?? "default"}`}
      role={toast.tone === "error" ? "alert" : "status"}
    >
      <span>{toast.message}</span>
      <button type="button" className="toast-close" onClick={onDismiss} aria-label={t("toast.dismiss")}>
        ×
      </button>
    </div>
  );
}

export function ToastViewport() {
  const { toasts, dismissToast } = useToast();
  if (toasts.length === 0) return null;

  return (
    <div className="toast-viewport">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  );
}
