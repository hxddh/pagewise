import { useI18n } from "../i18n";

interface ResizeHandleProps {
  onPointerDown: (e: React.PointerEvent) => void;
  /** Current panel width in px (for aria-valuenow). */
  value?: number;
  /** Minimum panel width in px (for aria-valuemin). */
  min?: number;
  /** Maximum panel width in px (for aria-valuemax). */
  max?: number;
  /**
   * Nudge the panel width by deltaPx via the keyboard. Positive = grow the
   * panel, negative = shrink it. Optional; defaults to a no-op.
   */
  onNudge?: (deltaPx: number) => void;
}

const NUDGE_PX = 16;

export function ResizeHandle({
  onPointerDown,
  value,
  min,
  max,
  onNudge = () => {},
}: ResizeHandleProps) {
  const { t } = useI18n();

  function handleKeyDown(e: React.KeyboardEvent) {
    // Right/Up grow the panel; Left/Down shrink it.
    switch (e.key) {
      case "ArrowRight":
      case "ArrowUp":
        e.preventDefault();
        onNudge(NUDGE_PX);
        break;
      case "ArrowLeft":
      case "ArrowDown":
        e.preventDefault();
        onNudge(-NUDGE_PX);
        break;
      default:
        break;
    }
  }

  return (
    <div
      className="resize-handle"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t("agent.resizePanel")}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={onPointerDown}
      onKeyDown={handleKeyDown}
    />
  );
}
