import { useI18n } from "../i18n";
import type { LoadProgress } from "../lib/load-progress";

interface LoadingOverlayProps {
  visible: boolean;
  progress: LoadProgress | null;
}

export function LoadingOverlay({ visible, progress }: LoadingOverlayProps) {
  const { t } = useI18n();
  if (!visible || !progress) return null;

  const message = progress.messageParams
    ? t(progress.message, progress.messageParams as Record<string, string | number>)
    : t(progress.message);

  return (
    <div className="loading-overlay" role="dialog" aria-modal="true" aria-busy="true" aria-label={message}>
      <div className="loading-card">
        <p className="loading-message">{message}</p>
        <div className="loading-bar-track">
          <div
            className="loading-bar-fill"
            style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
          />
        </div>
        <span className="loading-percent">{Math.round(progress.percent)}%</span>
      </div>
    </div>
  );
}
