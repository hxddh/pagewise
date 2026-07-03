import { useEffect, useState, type ReactNode } from "react";

export type ZoomMode = "fit-width" | number;

export const ZOOM_PRESETS: { label: string; value: ZoomMode }[] = [
  { label: "Fit", value: "fit-width" },
  { label: "100%", value: 1 },
  { label: "125%", value: 1.25 },
  { label: "150%", value: 1.5 },
  { label: "200%", value: 2 },
];

interface PreviewToolbarProps {
  filename: string;
  page: number;
  totalPages: number;
  zoom: ZoomMode;
  onZoomChange: (zoom: ZoomMode) => void;
  onPageChange: (page: number) => void;
  searchSlot?: ReactNode;
}

export function PreviewToolbar({
  filename,
  page,
  totalPages,
  zoom,
  onZoomChange,
  onPageChange,
  searchSlot,
}: PreviewToolbarProps) {
  const [pageInput, setPageInput] = useState(String(page));

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  function commitPageInput() {
    const n = parseInt(pageInput, 10);
    if (!Number.isFinite(n)) {
      setPageInput(String(page));
      return;
    }
    const clamped = Math.min(totalPages, Math.max(1, n));
    onPageChange(clamped);
    setPageInput(String(clamped));
  }

  return (
    <header className="preview-toolbar">
      <span className="preview-filename" title={filename}>
        {filename}
      </span>

      <div className="preview-toolbar-center">
        <button
          type="button"
          className="btn icon-btn"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label="Previous page"
        >
          ←
        </button>
        <div className="page-jump">
          <input
            className="page-jump-input"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
            onBlur={commitPageInput}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitPageInput();
              }
            }}
            aria-label="Page number"
          />
          <span className="page-jump-total">/ {totalPages}</span>
        </div>
        <button
          type="button"
          className="btn icon-btn"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label="Next page"
        >
          →
        </button>
      </div>

      <div className="preview-toolbar-right">
        {searchSlot}
        <select
          className="zoom-select"
          value={zoom === "fit-width" ? "fit-width" : String(zoom)}
          onChange={(e) => {
            const v = e.target.value;
            onZoomChange(v === "fit-width" ? "fit-width" : parseFloat(v));
          }}
        >
          {ZOOM_PRESETS.map((z) => (
            <option key={z.label} value={z.value === "fit-width" ? "fit-width" : String(z.value)}>
              {z.label}
            </option>
          ))}
        </select>
      </div>
    </header>
  );
}
