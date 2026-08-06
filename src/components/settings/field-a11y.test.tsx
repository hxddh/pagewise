// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Field } from "../ui/Field";

afterEach(cleanup);

vi.mock("../../i18n", () => ({ useI18n: () => ({ t: (k: string) => k }) }));

/**
 * Every settings control can be named by a screen reader.
 *
 * `Field` was built to fix exactly this — its own comment said so — and then
 * nothing adopted it for two releases. Three controls shipped with a `<span>`
 * label inside a `<div>`: visible text next to a box, and nothing connecting
 * them. One of those was a component extracted in 7.3, where the markup was
 * moved and the defect moved with it.
 *
 * These assert the connection itself rather than the markup, so a future
 * refactor is free to move the label anywhere that still names the control.
 */

function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    return labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  }
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  const id = el.getAttribute("id");
  if (id) {
    const label = el.ownerDocument.querySelector(`label[for="${id}"]`);
    if (label) return label.textContent?.trim() ?? "";
  }
  // An ancestor <label> names the control implicitly.
  return el.closest("label")?.textContent?.trim() ?? "";
}

describe("Field names the control it wraps", () => {
  it("gives an input a name through label[for]", () => {
    const { container } = render(
      <Field label="API key">{({ id }) => <input id={id} />}</Field>,
    );
    expect(accessibleName(container.querySelector("input")!)).toBe("API key");
  });

  it("gives a button a name too — label[for] alone cannot", () => {
    // A select-style trigger showing "gpt-4o" is announced as "gpt-4o" with no
    // indication of what it selects. This is the case that shipped broken.
    const { container } = render(
      <Field label="Agent model">
        {({ "aria-labelledby": labelledBy }) => (
          <button type="button" aria-labelledby={labelledBy}>
            gpt-4o
          </button>
        )}
      </Field>,
    );
    expect(accessibleName(container.querySelector("button")!)).toBe("Agent model");
  });

  it("points the control at its hint, and at its error instead when invalid", () => {
    const { container, rerender } = render(
      <Field label="Model" hint="Leave blank for the default">
        {(props) => <input {...props} />}
      </Field>,
    );
    const described = (el: Element) =>
      el.ownerDocument.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent;
    expect(described(container.querySelector("input")!)).toBe("Leave blank for the default");

    rerender(
      <Field label="Model" hint="Leave blank for the default" error="Unknown model">
        {(props) => <input {...props} />}
      </Field>,
    );
    expect(described(container.querySelector("input")!)).toBe("Unknown model");
  });

  it("does not claim a description when there is nothing to describe", () => {
    const { container } = render(<Field label="Model">{(props) => <input {...props} />}</Field>);
    expect(container.querySelector("input")!.hasAttribute("aria-describedby")).toBe(false);
  });
});
