import type { LoadProgress } from "../lib/load-progress";

interface LoadingOverlayProps {
  visible: boolean;
  progress: LoadProgress | null;
}

export function LoadingOverlay({ visible, progress }: LoadingOverlayProps) {
  if (!visible || !progress) return null;

  return (
    <div className="loading-overlay" role="status" aria-live="polite">
      <div className="loading-card">
        <p className="loading-message">{progress.message}</p>
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
