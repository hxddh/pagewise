interface ResizeHandleProps {
  onPointerDown: (e: React.PointerEvent) => void;
}

export function ResizeHandle({ onPointerDown }: ResizeHandleProps) {
  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize agent panel"
      onPointerDown={onPointerDown}
    />
  );
}
