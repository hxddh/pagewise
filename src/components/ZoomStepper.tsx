import { useRef, useState } from "react";
import { ChevronDown, Minus, Plus } from "lucide-react";
import { useI18n } from "../i18n";
import {
  formatZoomLabel,
  isSameZoom,
  type ZoomMode,
  ZOOM_PRESETS,
} from "../lib/zoom";
import { AnchoredMenu } from "./AnchoredMenu";

interface ZoomStepperProps {
  zoom: ZoomMode;
  onZoomChange: (zoom: ZoomMode) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  disabled?: boolean;
}

export function ZoomStepper({
  zoom,
  onZoomChange,
  onZoomIn,
  onZoomOut,
  disabled,
}: ZoomStepperProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  const label = formatZoomLabel(zoom, t);
  const atMin = zoom === "fit-width";
  const atMax = zoom === 2;

  return (
    <div
      ref={anchorRef}
      className={`toolbar-group toolbar-group-zoom ${disabled ? "disabled" : ""}`}
    >
      <button
        type="button"
        className="toolbar-btn toolbar-zoom-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-label={t("preview.zoom")}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="toolbar-zoom-label">{label}</span>
        <ChevronDown size={12} className="toolbar-zoom-chevron" aria-hidden />
      </button>
      <AnchoredMenu
        open={open && !disabled}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        className="anchored-popover zoom-presets-menu"
        align="end"
      >
        {ZOOM_PRESETS.map((z) => (
          <button
            key={z.labelKey}
            type="button"
            role="menuitemradio"
            aria-checked={isSameZoom(zoom, z.value)}
            className={`zoom-menu-item ${isSameZoom(zoom, z.value) ? "active" : ""}`}
            onClick={() => {
              onZoomChange(z.value);
              setOpen(false);
            }}
          >
            {t(z.labelKey)}
          </button>
        ))}
        <div className="zoom-menu-divider" role="separator" />
        <button
          type="button"
          role="menuitem"
          className="zoom-menu-item zoom-menu-action"
          onClick={() => {
            onZoomOut();
            setOpen(false);
          }}
          disabled={atMin}
        >
          <Minus size={12} aria-hidden />
          {t("preview.zoomOut")}
        </button>
        <button
          type="button"
          role="menuitem"
          className="zoom-menu-item zoom-menu-action"
          onClick={() => {
            onZoomIn();
            setOpen(false);
          }}
          disabled={atMax}
        >
          <Plus size={12} aria-hidden />
          {t("preview.zoomIn")}
        </button>
      </AnchoredMenu>
    </div>
  );
}
