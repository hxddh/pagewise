import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

/**
 * One row in a list.
 *
 * The app had fifteen of these — a thumbnail, an outline entry, a mark, a
 * record entry, a recent file, a palette item, a model, a provider, an export
 * option, a search hit — and each one re-answered the same questions on its
 * own: what element is it, what happens when it is the row you are on, how does
 * the keyboard find it. Fourteen of them wrote `<button>` and a template
 * literal, and the differences between them were accidents of history rather
 * than decisions.
 *
 * The slots are positions, not wrappers: every caller already has a class for
 * its own contents (`.outline-title`, `.library-name`, `.export-option-text`),
 * and the stylesheet for a row is written against that markup. Wrapping them
 * here would mean rewriting fifteen stylesheets to say the same thing again.
 * What this owns is the element and the state: `type="button"`, the `active`
 * class that `14-states.css` is the single home of, and `aria-current` for the
 * row you are on.
 *
 * `leading`, `label`, `meta` and `trailing` are rendered in that order; a row
 * that needs two of them passes two.
 */
interface ListRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  /** A thumbnail, an icon, a page number. */
  leading?: ReactNode;
  /** The row's own label. (`title` is the tooltip attribute, as in HTML.) */
  label?: ReactNode;
  /** Secondary lines under the title. */
  meta?: ReactNode;
  /** A page number, a shortcut, an action. */
  trailing?: ReactNode;
  /** The row you are on. Styled only by `14-states.css`. */
  active?: boolean;
  /**
   * What `aria-current` should say for the active row. `"true"` for "this is
   * the one", `"page"` for a thumbnail — the row is a page, and the reader's
   * position in the document is what it reports.
   */
  current?: "true" | "page";
  className?: string;
  /** Rows are focused by their owner (the palette's cursor, a sidebar's follow). */
  ref?: Ref<HTMLButtonElement>;
}

export function ListRow({
  leading,
  label,
  meta,
  trailing,
  active = false,
  current = "true",
  className = "",
  ...rest
}: ListRowProps) {
  const classes = ["list-row", className, active ? "active" : ""].filter(Boolean).join(" ");
  return (
    // raw-button: the primitive itself — it is what renders the element (see check-raw-buttons.mjs)
    <button
      type="button"
      className={classes}
      aria-current={active ? current : undefined}
      {...rest}
    >
      {leading}
      {label}
      {meta}
      {trailing}
    </button>
  );
}
