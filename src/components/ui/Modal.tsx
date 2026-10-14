import { Dialog } from "radix-ui";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import {
  closeOverlay,
  openOverlay,
  popOverlayLayer,
  pushOverlayLayer,
} from "../../lib/overlay-state";
import { Panel, type PanelTone } from "./Panel";

/**
 * A modal, in one place.
 *
 * Five modals in this app each wrote the same protocol by hand: a full-bleed
 * backdrop `<button>` with a `raw-button:` reason, an `Escape` listener that
 * consulted the app's own layer stack, a focus trap, and a `useOverlayLock`.
 * Twelve files hand-rolled some part of it, and the parts disagreed — which is
 * what a protocol copied twelve times does.
 *
 * Radix owns the protocol now: Escape, the backdrop and outside-pointer
 * dismissal, focus trapping and restoration, `aria-modal`, and the scroll lock.
 * What is left here is the two things Radix cannot know about this app:
 *
 *   - the *layer*, so global shortcuts stay suspended (`openOverlay`) and the
 *     app's own Escape handlers — the mark note, the preview's region mode —
 *     can see that something modal is above them (`pushOverlayLayer`);
 *   - the *surface*, which is this app's `Panel` and this app's classes. Radix
 *     is headless; nothing here restyles anything.
 *
 * `container` exists for one caller: the in-document search is positioned
 * inside the preview panel rather than over the window, so it portals there.
 */
interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** The full-bleed layer: where the modal sits, and what dims behind it. */
  overlayClassName: string;
  /** The surface's own class — `palette-panel`, `library-drawer`, … */
  className: string;
  /** The app's Panel surface, where the modal is one. */
  tone?: PanelTone;
  /** Where the portal goes. Defaults to `document.body`. */
  container?: HTMLElement | null;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /** The control the caret should start on, where it is not the first one. */
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  overlayClassName,
  className,
  tone,
  container,
  ariaLabel,
  ariaLabelledBy,
  initialFocus,
  children,
}: ModalProps) {
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
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal container={container ?? undefined}>
        {/*
          The overlay class is the app's *container* — every one of these was
          written as a full-bleed box that positions the panel inside it (flex
          centring for the palette, flex-end for the drawer, absolute inset for
          the library). Radix renders its overlay and its content as siblings,
          so applying that class to the overlay alone left the panel a
          normal-flow child of the portal: at the top-left of the window, under
          the scrim, unclickable. Wrapping both keeps the old geometry and the
          old z-index, and the scrim becomes one shared rule.
        */}
        <div className={overlayClassName}>
          <Dialog.Overlay className="modal-scrim" />
          <Dialog.Content
          asChild
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          onOpenAutoFocus={(event) => {
            // The element to hand focus back to on close. Radix has no Trigger
            // here — these dialogs are opened from state — so its own restore
            // has nothing to aim at.
            openerRef.current = document.activeElement as HTMLElement | null;
            if (initialFocus?.current) {
              event.preventDefault();
              initialFocus.current.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            openerRef.current?.focus?.();
          }}
          >
            {tone ? (
              <Panel tone={tone} className={className}>
                {children}
              </Panel>
            ) : (
              <div className={className}>{children}</div>
            )}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
