import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import {
  isTopOverlayLayer,
  popOverlayLayer,
  pushOverlayLayer,
} from "../lib/overlay-state";

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
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Read through refs so the mount effect can run exactly once. Callers pass an
  // inline onCancel whose identity changes every parent render; depending on it
  // would re-run the effect and yank focus back to the initial button (and churn
  // the escape layer) on every unrelated re-render.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const dangerRef = useRef(danger);
  dangerRef.current = danger;

  // Register as the topmost escape layer while mounted, and give it initial
  // focus so the alertdialog is keyboard-operable. For destructive prompts the
  // safe (cancel) action receives focus.
  useEffect(() => {
    const layerId = pushOverlayLayer();
    (dangerRef.current ? cancelRef.current : confirmRef.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopOverlayLayer(layerId)) {
        e.preventDefault();
        e.stopPropagation();
        onCancelRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      popOverlayLayer(layerId);
    };
  }, []);

  return (
    <div className="confirm-bar" role="alertdialog" aria-live="assertive">
      <p className="confirm-bar-message">{message}</p>
      <div className="confirm-bar-actions">
        <button ref={cancelRef} type="button" className="btn ghost" onClick={onCancel}>
          {cancel}
        </button>
        <button
          ref={confirmRef}
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
