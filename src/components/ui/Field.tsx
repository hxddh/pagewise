import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

type Size = "sm" | "md";

// `size` on a native input means "visible character width"; ours means the
// control's height step, so the native one is displaced deliberately.
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: Size;
  /** Right-aligned digits, for page numbers and zoom levels. */
  numeric?: boolean;
}

/**
 * Every text input in the app.
 *
 * Fifteen CSS rules each defined a full input box — border, radius, background,
 * height, focus ring — for the composer, the settings fields, the page jump,
 * the search box, the mark note. Same disease the buttons had before 7.0: none
 * of them wrong, no two of them alike.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = "md", numeric = false, className = "", ...rest },
  ref,
) {
  const classes = ["ui-input", `ui-input--${size}`, numeric ? "ui-input--numeric" : "", className]
    .filter(Boolean)
    .join(" ");
  return <input ref={ref} className={classes} {...rest} />;
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  size?: Size;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { size = "md", className = "", ...rest },
  ref,
) {
  const classes = ["ui-input", "ui-textarea", `ui-input--${size}`, className]
    .filter(Boolean)
    .join(" ");
  return <textarea ref={ref} className={classes} {...rest} />;
});

export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  /**
   * For controls a `<label for>` cannot name.
   *
   * A `<label>` associates with form controls; a `<button>` takes its name from
   * its own content instead, so a select-style trigger showing "gpt-4o" is
   * announced as "gpt-4o" with no indication of what it selects. Such controls
   * take `aria-labelledby` and ignore `id`.
   */
  "aria-labelledby": string;
}

export interface FieldProps {
  label: ReactNode;
  /** Explanation under the control. */
  hint?: ReactNode;
  /** Replaces the hint and marks the control invalid. */
  error?: ReactNode;
  children: (props: FieldControlProps) => ReactNode;
}

/**
 * A labelled control.
 *
 * The label, the control and the note under it were assembled by hand at each
 * call site, which is why some had `htmlFor` and some did not.
 *
 * That was written when this was built and stayed true for two releases,
 * because nothing adopted it: every settings field kept its hand-rolled
 * `<span>` label, and three of them wrapped in a `<div>` rather than a
 * `<label>`, so their controls had no accessible name at all. Adopting this is
 * what fixed that — the primitive was never the hard part.
 */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const noteId = hint || error ? `${id}-note` : undefined;
  return (
    <div className={`ui-field${error ? " ui-field--error" : ""}`}>
      <label className="ui-field-label" id={labelId} htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        "aria-labelledby": labelId,
        ...(noteId ? { "aria-describedby": noteId } : {}),
      })}
      {(error || hint) && (
        <p className="ui-field-note" id={noteId}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
