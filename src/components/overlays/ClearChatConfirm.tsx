import { ConfirmBar } from "../ConfirmBar";
import { useOverlayLock } from "../../hooks/useOverlayLock";
import { Panel } from "../ui/Panel";

interface ClearChatConfirmProps {
  open: boolean;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ClearChatConfirm({
  open,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: ClearChatConfirmProps) {
  useOverlayLock(open);
  if (!open) return null;
  return (
    <Panel tone="elevated" className="global-confirm">
      <ConfirmBar
        message={message}
        confirmLabel={confirmLabel}
        danger
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </Panel>
  );
}
