interface DropOverlayProps {
  visible: boolean;
}

export function DropOverlay({ visible }: DropOverlayProps) {
  if (!visible) return null;

  return (
    <div className="drop-overlay">
      <div className="drop-overlay-inner">
        <p className="drop-title">Drop to open</p>
        <p className="drop-hint">PDF, PNG, JPG, WebP, TIFF…</p>
      </div>
    </div>
  );
}
