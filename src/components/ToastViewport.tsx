import { useI18n } from "../i18n";
import { useToast, type Toast } from "../hooks/useToast";
import { StatusLine } from "./ui/StatusLine";

/**
 * Where toasts appear. What one *is* comes from `StatusLine` — this owns the
 * corner and the stack, nothing else.
 */
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { t } = useI18n();
  return (
    <StatusLine
      role="toast"
      tone={toast.tone ?? "default"}
      message={toast.message}
      onDismiss={onDismiss}
      dismissLabel={t("toast.dismiss")}
    />
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
