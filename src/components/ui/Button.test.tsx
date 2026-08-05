// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./Button";

afterEach(cleanup);

describe("Button", () => {
  it("carries its intent and size as classes rather than as bespoke CSS", () => {
    const { container } = render(
      <Button variant="primary" size="lg">
        Open
      </Button>,
    );
    const el = container.querySelector("button")!;
    expect(el.className.split(" ")).toEqual(
      expect.arrayContaining(["ui-btn", "ui-btn--primary", "ui-btn--lg"]),
    );
  });

  it("defaults to a button, never a form submit", () => {
    // A button inside a form that submits it by accident is a bug that only
    // shows up once someone presses Enter in the field next to it.
    const { container } = render(<Button>Cancel</Button>);
    expect(container.querySelector("button")!.type).toBe("button");
  });

  it("lets a caller keep a placement class without losing the primitive", () => {
    const { container } = render(<Button className="mark-ask-btn">Ask</Button>);
    const el = container.querySelector("button")!;
    expect(el.classList.contains("ui-btn")).toBe(true);
    expect(el.classList.contains("mark-ask-btn")).toBe(true);
  });

  it("marks an icon button square", () => {
    const { container } = render(<Button icon aria-label="close">×</Button>);
    expect(container.querySelector("button")!.classList.contains("ui-btn--icon")).toBe(true);
  });

  it("still behaves like a button", () => {
    const onClick = vi.fn();
    const { container } = render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(container.querySelector("button")!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("passes disabled through", () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button disabled onClick={onClick}>
        Go
      </Button>,
    );
    fireEvent.click(container.querySelector("button")!);
    expect(onClick).not.toHaveBeenCalled();
  });
});
