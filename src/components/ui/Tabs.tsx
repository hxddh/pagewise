import { useRef, type ReactNode } from "react";

/**
 * A strip of tabs.
 *
 * Two of these were hand-copied — the page sidebar's Pages/Outline/Marks and
 * the assistant's Chat/Record — and both wrote out the same `role="tablist"`,
 * the same `aria-selected`, the same `active` class and the same three-line
 * template. The strip is 143px of 11px text; a change to how "this one is on"
 * reads had to be made in two files, and 8.1.3 records what happened when only
 * one of them fitted its header.
 *
 * The state is `is-on` in `14-states.css`, the same idiom as every other
 * segmented control in the app: a tab here is not a `<Button>` (it has no box
 * and no height of its own), which is why the element is written here.
 *
 * Since 19.0 the strip answers the arrow keys too — left/right (and down/up)
 * walk the tabs, Home/End jump to the ends, and a disabled tab is skipped
 * rather than a place focus gets stuck. Tab itself still reaches every tab, so
 * nothing here *depends* on the arrows (19.0, package 4: every surface reachable
 * by keyboard alone); they are what makes a tablist behave like one rather than
 * like three buttons that happen to sit together.
 */
export interface TabItem<T extends string> {
  id: T;
  label: string;
  /** A count or a dot that rides with the label. */
  badge?: ReactNode;
  /** A tab with nothing behind it says so rather than falling back silently. */
  disabled?: boolean;
}

interface TabsProps<T extends string> {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Extra class for the strip — `panel-tabs` and the like. */
  className?: string;
  ariaLabel?: string;
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className = "",
  ariaLabel,
}: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    const enabled = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);
    const at = enabled.indexOf(index);
    if (at < 0) return;
    let next = -1;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = enabled[(at + 1) % enabled.length]!;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = enabled[(at - 1 + enabled.length) % enabled.length]!;
        break;
      case "Home":
        next = enabled[0]!;
        break;
      case "End":
        next = enabled[enabled.length - 1]!;
        break;
      default:
        return;
    }
    e.preventDefault();
    // Activation follows focus, because these tabs switch a panel in place and
    // there is nothing to undo by looking.
    onChange(items[next]!.id);
    refs.current[next]?.focus();
  }

  return (
    <div className={`sidebar-tabs ${className}`.trim()} role="tablist" aria-label={ariaLabel}>
      {items.map((item, index) => (
        // raw-button: the primitive itself — a tab is not a button and must not be styled as one
        <button
          key={item.id}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          disabled={item.disabled}
          className={`sidebar-tab ${value === item.id ? "active" : ""}`}
          onClick={() => onChange(item.id)}
          onKeyDown={(e) => onKeyDown(e, index)}
        >
          {item.label}
          {item.badge}
        </button>
      ))}
    </div>
  );
}
