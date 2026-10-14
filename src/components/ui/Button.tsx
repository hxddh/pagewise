import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "link";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Square, sized for a single glyph. Needs an aria-label. */
  icon?: boolean;
}

/**
 * Every button in the app.
 *
 * There were twenty-one different button class names — `btn`, `icon-btn`,
 * `settings-btn-primary`, `stop-btn`, `mark-ask-btn`, `message-action-btn` and
 * on — each with its own padding, height, hover and focus. None of them was
 * wrong on its own; the effect of all of them together is that no two buttons
 * in the app are quite the same, which is what "rough" looks like up close.
 *
 * Four intents and three sizes cover every one of them. Placement stays with
 * the caller — a class on top of this positions it — but what a button *is*
 * lives here.
 *
 * What is deliberately NOT a Button, having gone through the remaining bare
 * `<button>` elements one at a time:
 *
 *   backdrops       .doc-search-backdrop, .palette-backdrop, .drawer-backdrop,
 *                   .library-drawer-backdrop — invisible full-screen click
 *                   catchers. 18.0 deleted all four: they were a protocol
 *                   written by hand five times, and the Radix overlay is that
 *                   layer with the click and the focus behaviour included.
 *
 *   menu items      anything inside `.anchored-popover`, which styles its own
 *                   `button` children as full-width menu rows. Layering ui-btn
 *                   on top means two systems fighting over the same element.
 *
 *   clickable       .thumb-item, .welcome-recent-card, .provider-cell,
 *   content         .library-item, .doc-search-hit, .outline-item, .zoom-menu-item,
 *                   .palette-item, .export-option, .mark-item, .record-page-chip
 *                   — a page thumbnail, a search hit, a recent file, a menu row.
 *                   These are content you click, and their selected state,
 *                   layout and density belong to the list they sit in: since
 *                   18.0 they render through `<ListRow>`, which owns the element
 *                   and the state and leaves the layout to the list.
 *
 *   inline marks    .page-ref-link, .pdf-link, .tool-step-link, .pages-read-chip,
 *                   .settings-pill — text-level affordances sized to the type
 *                   around them.
 *
 * The point of writing this down is that the ratio of <Button> to <button> is
 * not a to-do list, and nobody has to make these calls a second time.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon = false, className = "", type, ...rest },
  ref,
) {
  const classes = [
    "ui-btn",
    `ui-btn--${variant}`,
    `ui-btn--${size}`,
    icon ? "ui-btn--icon" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  // Defaulting to "button" rather than the HTML default: a button inside a form
  // that submits it by accident is a class of bug nobody enjoys finding.
  return <button ref={ref} type={type ?? "button"} className={classes} {...rest} />;
});
