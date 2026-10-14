export type ZoomMode = "fit-width" | number;

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

export const ZOOM_PRESETS: { labelKey: string; value: ZoomMode }[] = [
  { labelKey: "preview.fitWidth", value: "fit-width" },
  { labelKey: "preview.zoom100", value: 1 },
  { labelKey: "preview.zoom125", value: 1.25 },
  { labelKey: "preview.zoom150", value: 1.5 },
  { labelKey: "preview.zoom200", value: 2 },
];

export const ZOOM_STEPS: ZoomMode[] = ["fit-width", 1, 1.25, 1.5, 2];

export function stepZoom(current: ZoomMode, direction: 1 | -1): ZoomMode {
  let idx = ZOOM_STEPS.findIndex(
    (s) =>
      s === current ||
      (typeof s === "number" && typeof current === "number" && s === current),
  );
  if (idx < 0) idx = current === "fit-width" ? 0 : 1;
  const next = idx + direction;
  if (next < 0) return ZOOM_STEPS[0]!;
  if (next >= ZOOM_STEPS.length) return ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  return ZOOM_STEPS[next]!;
}

export function formatZoomLabel(zoom: ZoomMode, t?: TranslateFn): string {
  if (zoom === "fit-width") {
    return t?.("preview.fitWidthShort") ?? "Fit";
  }
  return `${Math.round(zoom * 100)}%`;
}

export function isSameZoom(a: ZoomMode, b: ZoomMode): boolean {
  return a === b || (typeof a === "number" && typeof b === "number" && a === b);
}
