import type { ReactNode } from "react";

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
  return (
    <div className={`sidebar-tabs ${className}`.trim()} role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        // raw-button: the primitive itself — a tab is not a button and must not be styled as one
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          disabled={item.disabled}
          className={`sidebar-tab ${value === item.id ? "active" : ""}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.badge}
        </button>
      ))}
    </div>
  );
}
