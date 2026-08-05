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
