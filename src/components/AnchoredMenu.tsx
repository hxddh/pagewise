import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

interface AnchoredMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  align?: "start" | "end";
  /** ARIA role for the popover container. Defaults to "menu"; pass "listbox" for option lists. */
  role?: "menu" | "listbox";
}

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
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" });
  // Element focused before the menu opened, so we can restore focus on close.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const getItems = useCallback((): HTMLElement[] => {
    const root = menuRef.current;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    );
  }, []);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !menuRef.current) return;

    const position = () => {
      if (!anchorRef.current || !menuRef.current) return;
      const anchor = anchorRef.current.getBoundingClientRect();
      const menu = menuRef.current.getBoundingClientRect();
      const gap = 4;
      let top = anchor.bottom + gap;
      if (top + menu.height > window.innerHeight - 8) {
        top = Math.max(8, anchor.top - menu.height - gap);
      }
      const left =
        align === "end"
          ? Math.max(8, anchor.right - menu.width)
          : Math.max(8, Math.min(anchor.left, window.innerWidth - menu.width - 8));

      setStyle({
        position: "fixed",
        top,
        left,
        right: "auto",
        width: "max-content",
        zIndex: "var(--z-menu)",
        visibility: "visible",
      });
    };

    position();
    const raf = requestAnimationFrame(position);
    // Keep the menu anchored while the page scrolls or the window resizes.
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
    };
  }, [open, anchorRef, align]);

  // Move focus into the menu on open; restore it to the trigger on close.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const id = window.setTimeout(() => {
      getItems()[0]?.focus();
    }, 0);
    return () => {
      window.clearTimeout(id);
      restoreFocusRef.current?.focus?.();
    };
  }, [open, getItems]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, onClose, anchorRef]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
        case "Tab":
          // Tabbing away dismisses the menu (WAI-ARIA menu pattern).
          onClose();
          break;
        default:
          break;
      }
    },
    [getItems, onClose],
  );

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={className}
      style={style}
      role={role}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
