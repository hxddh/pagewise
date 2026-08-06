import type { HTMLAttributes, ReactNode } from "react";

export type PanelTone = "surface" | "elevated" | "inset";

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  tone?: PanelTone;
  /** Adds the standard inner padding. Off for panels that lay out their own. */
  padded?: boolean;
  children?: ReactNode;
}

/**
 * A bounded surface: a card, a popover, a section of settings.
 *
 * There were forty-six class names in this family — panel, card, menu, popover,
 * drawer, overlay — each choosing its own background, border, radius and
 * shadow. Three tones cover what they were actually expressing: the page's own
 * surface, something lifted above it, and something recessed into it.
 */
export function Panel({
  tone = "surface",
  padded = false,
  className = "",
  children,
  ...rest
}: PanelProps) {
  const classes = [
    "ui-panel",
    `ui-panel--${tone}`,
    padded ? "ui-panel--padded" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} {...rest}>
      {children}
    </div>
  );
}
