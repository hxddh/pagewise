import type { ReactNode } from "react";
import { Button } from "./Button";

/**
 * One line that tells the reader something happened, in three roles.
 *
 * The app had eight visual treatments of this — a toast, a fixed banner, an
 * inline error under the conversation, a scan hint that looked exactly like an
 * error but was an offer, a settings footer, a settings callout, a connection
 * chip — and the same sentence could arrive in any of them depending on which
 * corner of the code produced it. The treatments were not wrong one at a time;
 * what was missing was the set of names, so the reader could learn that the
 * same kind of thing is happening again.
 *
 *   toast   — an event that goes past. The viewport owns where it sits; this
 *             owns what it is. Dismissible, and it says so.
 *   inline  — a state of the thing it sits under (a failed turn, a page that
 *             was never scanned). It stays until the state changes.
 *   banner  — the same, for the whole window: the one surface a failed open is
 *             reported through, because that is a state the reader is left
 *             sitting in.
 *
 * The `role` and `aria-live` semantics follow the tone rather than the role: a
 * failure is `alert` (assertive — it interrupts because it must), everything
 * else is `status` (polite — it waits for a pause). That is what the eight
 * treatments each decided on their own, and three of them decided wrong.
 */
export type StatusLineRole = "toast" | "inline" | "banner";
export type StatusLineTone = "default" | "success" | "error";

interface StatusLineProps {
  role: StatusLineRole;
  /** The ink, not the shape: what happened, not where it is shown. */
  tone?: StatusLineTone;
  message: ReactNode;
  /** The controls that act on what the line says. */
  actions?: ReactNode;
  /** Placement — the margins the host gives a line, the banner's corner. */
  className?: string;
  /** Provided where the line can be put away; the × is then part of it. */
  onDismiss?: () => void;
  dismissLabel?: string;
}

export function StatusLine({
  role,
  tone = "default",
  message,
  actions,
  className = "",
  onDismiss,
  dismissLabel,
}: StatusLineProps) {
  const classes = ["status-line", `status-line-${role}`, `status-line-${tone}`, className]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} role={tone === "error" ? "alert" : "status"}>
      <span className="status-line-text">{message}</span>
      {actions && <span className="status-line-actions">{actions}</span>}
      {onDismiss && (
        <Button
          variant="ghost"
          size="md"
          icon
          className="status-line-close"
          onClick={onDismiss}
          aria-label={dismissLabel}
          title={dismissLabel}
        >
          ×
        </Button>
      )}
    </div>
  );
}
