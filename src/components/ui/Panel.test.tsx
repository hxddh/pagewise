// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Panel } from "./Panel";

afterEach(cleanup);

describe("Panel", () => {
  it("expresses a surface as a tone rather than as its own background rule", () => {
    const { container } = render(<Panel tone="elevated">x</Panel>);
    const el = container.firstElementChild!;
    expect(el.className.split(" ")).toEqual(
      expect.arrayContaining(["ui-panel", "ui-panel--elevated"]),
    );
  });

  it("leaves layout to the caller unless asked to pad", () => {
    const { container, rerender } = render(<Panel>x</Panel>);
    expect(container.firstElementChild!.classList.contains("ui-panel--padded")).toBe(false);
    rerender(<Panel padded>x</Panel>);
    expect(container.firstElementChild!.classList.contains("ui-panel--padded")).toBe(true);
  });

  it("passes through the attributes a div would take", () => {
    const { container } = render(
      <Panel role="dialog" aria-label="settings" className="settings-card">
        x
      </Panel>,
    );
    const el = container.firstElementChild!;
    expect(el.getAttribute("role")).toBe("dialog");
    expect(el.classList.contains("settings-card")).toBe(true);
  });
});
