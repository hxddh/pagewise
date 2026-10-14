import { AlertDialog } from "radix-ui";
import { useEffect, useRef } from "react";
import { useI18n } from "../../i18n";
import {
  closeOverlay,
  openOverlay,
  popOverlayLayer,
  pushOverlayLayer,
} from "../../lib/overlay-state";
import { Button } from "../ui/Button";
import { Panel } from "../ui/Panel";

interface ConfirmDialogProps {
  open: boolean;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the action as destructive and puts the safe one under the caret. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The app's one confirm prompt.
 *
 * There were two wrappers around one hand-written bar — `ConfirmOverlay` and
 * `ClearChatConfirm` — that differed by a `danger` prop and nothing else, and
 * the bar underneath them wrote its own Escape layer, its own initial focus and
 * its own `role="alertdialog"`.
 *
 * Radix's AlertDialog is the right primitive rather than Dialog: it is the one
 * that does not dismiss on an outside click, and it puts the safe action under
 * the caret. The corner placement stays (`global-confirm`) and so does the bar's
 * markup — this is the same card in the same corner, with the protocol owned by
 * something that has already thought about it.
 */
export function ConfirmDialog({
  open,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const cancel = cancelLabel ?? t("common.cancel");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const token = openOverlay();
    const layer = pushOverlayLayer();
    return () => {
      closeOverlay(token);
      popOverlayLayer(layer);
    };
  }, [open]);

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialog.Content
        asChild
        onOpenAutoFocus={(event) => {
          openerRef.current = document.activeElement as HTMLElement | null;
          // Radix's default is the cancel action — the safe one for a
          // destructive prompt. A prompt that only asks ("scan every page?")
          // keeps the old behaviour and starts on the action.
          if (!danger && confirmRef.current) {
            event.preventDefault();
            confirmRef.current.focus();
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          openerRef.current?.focus?.();
        }}
      >
        <Panel tone="elevated" className="global-confirm" aria-live="assertive">
          <div className="confirm-bar">
            <p className="confirm-bar-message">{message}</p>
            <div className="confirm-bar-actions">
              <AlertDialog.Cancel asChild>
                <Button variant="ghost" size="md" onClick={onCancel}>
                  {cancel}
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  ref={confirmRef}
                  variant="primary"
                  size="md"
                  className={danger ? "danger-btn" : ""}
                  onClick={onConfirm}
                >
                  {confirmLabel}
                </Button>
              </AlertDialog.Action>
            </div>
          </div>
        </Panel>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
