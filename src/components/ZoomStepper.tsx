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
import { Button } from "./ui/Button";
import { ListRow } from "./ui/ListRow";

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
  // Derive bounds from the preset range rather than hardcoding magic values.
  const atMin = isSameZoom(zoom, ZOOM_PRESETS[0]!.value);
  const atMax = isSameZoom(zoom, ZOOM_PRESETS[ZOOM_PRESETS.length - 1]!.value);

  return (
    <div
      ref={anchorRef}
      className={`toolbar-group toolbar-group-zoom ${disabled ? "disabled" : ""}`}
    >
      <Button variant="ghost" size="md"
       
        className="toolbar-btn toolbar-zoom-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-label={t("preview.zoom")}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="toolbar-zoom-label">{label}</span>
        <ChevronDown size={12} className="toolbar-zoom-chevron" aria-hidden />
      </Button>
      <AnchoredMenu
        open={open && !disabled}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        className="anchored-popover zoom-presets-menu"
        align="end"
      >
        {ZOOM_PRESETS.map((z) => (
          <ListRow
            key={z.labelKey}
            role="menuitemradio"
            aria-checked={isSameZoom(zoom, z.value)}
            className="zoom-menu-item"
            active={isSameZoom(zoom, z.value)}
            label={t(z.labelKey)}
            onClick={() => {
              onZoomChange(z.value);
              setOpen(false);
            }}
          />
        ))}
        <div className="zoom-menu-divider" role="separator" />
        <ListRow
          role="menuitem"
          className="zoom-menu-item zoom-menu-action"
          leading={<Minus size={12} aria-hidden />}
          label={t("preview.zoomOut")}
          onClick={() => {
            onZoomOut();
            setOpen(false);
          }}
          disabled={atMin}
        />
        <ListRow
          role="menuitem"
          className="zoom-menu-item zoom-menu-action"
          leading={<Plus size={12} aria-hidden />}
          label={t("preview.zoomIn")}
          onClick={() => {
            onZoomIn();
            setOpen(false);
          }}
          disabled={atMax}
        />
      </AnchoredMenu>
    </div>
  );
}
