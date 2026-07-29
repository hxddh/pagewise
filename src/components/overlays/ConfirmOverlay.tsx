import { ConfirmBar } from "../ConfirmBar";
import { useOverlayLock } from "../../hooks/useOverlayLock";

interface ConfirmOverlayProps {
  open: boolean;
  message: string;
  confirmLabel: string;
  /** Focuses Cancel and styles the action as destructive. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Generic centered confirm prompt (see ClearChatConfirm for the destructive one). */
export function ConfirmOverlay({
  open,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmOverlayProps) {
  useOverlayLock(open);
  if (!open) return null;
  return (
    <div className="global-confirm">
      <ConfirmBar
        message={message}
        confirmLabel={confirmLabel}
        danger={danger}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </div>
  );
}
