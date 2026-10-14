import { Popover } from "radix-ui";
import { useCallback, useRef, type ReactNode, type RefObject } from "react";

interface AnchoredMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  align?: "start" | "end";
  /**
   * ARIA role for the popover container. Defaults to "menu"; pass "listbox" for
   * option lists, or "dialog" for popovers with no focusable menu items (e.g. a
   * read-only stats panel that must still close on Escape).
   */
  role?: "menu" | "listbox" | "dialog";
}

/**
 * A small surface anchored to a control: the zoom presets, the chat's overflow
 * menu, the answer's actions, the model list.
 *
 * Placement, outside-pointer dismissal and Escape were written by hand here —
 * a layout effect with its own flip-above-the-anchor arithmetic, a document
 * `mousedown` listener, a scroll/resize pair, a portal, a focus move and a
 * focus restore. Radix's Popover owns all of that now, and the two things it
 * cannot know stay in this file: which element to anchor to (the trigger lives
 * in the caller, so the anchor is registered virtually) and the arrow-key
 * cursor, which is a menu behaviour and not a popover one.
 */
export function AnchoredMenu({
  open,
  onClose,
  anchorRef,
  children,
  className = "anchored-popover",
  align = "end",
  role = "menu",
}: AnchoredMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const getItems = useCallback((): HTMLElement[] => {
    const root = menuRef.current;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    );
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Escape and outside-pointer dismissal are Radix's. What is left is the
      // cursor: Home/End/arrows move it, and Tab leaves (WAI-ARIA menu pattern).
      if (e.key === "Tab") {
        onClose();
        return;
      }

      const items = getItems();
      if (items.length === 0) return;
      const current = document.activeElement as HTMLElement | null;
      const index = current ? items.indexOf(current) : -1;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          items[index < 0 ? 0 : (index + 1) % items.length]?.focus();
          break;
        case "ArrowUp":
          e.preventDefault();
          items[index <= 0 ? items.length - 1 : index - 1]?.focus();
          break;
        case "Home":
          e.preventDefault();
          items[0]?.focus();
          break;
        case "End":
          e.preventDefault();
          items[items.length - 1]?.focus();
          break;
        default:
          break;
      }
    },
    [getItems, onClose],
  );

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/* The trigger is the caller's own button, so the anchor is virtual. */}
      <Popover.Anchor virtualRef={anchorRef} />
      <Popover.Portal>
        <Popover.Content
          ref={menuRef}
          className={className}
          role={role}
          tabIndex={-1}
          side="bottom"
          align={align}
          sideOffset={4}
          collisionPadding={8}
          style={{ zIndex: "var(--z-menu)" }}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(event) => {
            restoreFocusRef.current = document.activeElement as HTMLElement | null;
            // Radix focuses the first tabbable item, or the container when
            // there is none — which is what this did by hand.
            if (!event.defaultPrevented && getItems().length === 0) {
              event.preventDefault();
              menuRef.current?.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocusRef.current?.focus?.();
          }}
          onInteractOutside={(event) => {
            // Clicking the anchor is the caller's toggle, not a dismissal —
            // otherwise the dismiss and the toggle cancel each other out and
            // the menu can never be closed by its own button.
            const target = event.target as Node | null;
            if (target && anchorRef.current?.contains(target)) event.preventDefault();
          }}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
