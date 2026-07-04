import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

interface AnchoredMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  align?: "start" | "end";
}

export function AnchoredMenu({
  open,
  onClose,
  anchorRef,
  children,
  className = "anchored-popover",
  align = "end",
}: AnchoredMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" });

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
        zIndex: 10000,
        visibility: "visible",
      });
    };

    position();
    const raf = requestAnimationFrame(position);
    return () => cancelAnimationFrame(raf);
  }, [open, anchorRef, align]);

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

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={className}
      style={style}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
