export type ZoomMode = "fit-width" | "fit-page" | "comfortable" | number;

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

export const ZOOM_PRESETS: { labelKey: string; value: ZoomMode }[] = [
  { labelKey: "preview.fitWidth", value: "fit-width" },
  { labelKey: "preview.fitPage", value: "fit-page" },
  { labelKey: "preview.fitComfortable", value: "comfortable" },
  { labelKey: "preview.zoom100", value: 1 },
  { labelKey: "preview.zoom125", value: 1.25 },
  { labelKey: "preview.zoom150", value: 1.5 },
  { labelKey: "preview.zoom200", value: 2 },
];

export const NUMERIC_ZOOM_STEPS: readonly number[] = [
  0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
];

export const ZOOM_STEPS: ZoomMode[] = ["fit-width", ...NUMERIC_ZOOM_STEPS];

const STEP_EPSILON = 0.015;

export function stepZoom(current: ZoomMode, direction: 1 | -1, resolvedScale?: number): ZoomMode {
  const base =
    typeof current === "number"
      ? current
      : resolvedScale !== undefined && Number.isFinite(resolvedScale) && resolvedScale > 0
        ? resolvedScale
        : 1;

  if (direction === 1) {
    for (const step of NUMERIC_ZOOM_STEPS) {
      if (step > base + STEP_EPSILON) return step;
    }
    return NUMERIC_ZOOM_STEPS[NUMERIC_ZOOM_STEPS.length - 1]!;
  }

  for (let i = NUMERIC_ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    const step = NUMERIC_ZOOM_STEPS[i]!;
    if (step < base - STEP_EPSILON) return step;
  }
  return NUMERIC_ZOOM_STEPS[0]!;
}

export function formatZoomLabel(zoom: ZoomMode, t?: TranslateFn): string {
  if (zoom === "fit-width") {
    return t?.("preview.fitWidthShort") ?? "Fit";
  }
  if (zoom === "fit-page") {
    return t?.("preview.fitPageShort") ?? "Page";
  }
  if (zoom === "comfortable") {
    return t?.("preview.fitComfortableShort") ?? "Read";
  }
  return `${Math.round(zoom * 100)}%`;
}

export function isSameZoom(a: ZoomMode, b: ZoomMode): boolean {
  return a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.001);
}
