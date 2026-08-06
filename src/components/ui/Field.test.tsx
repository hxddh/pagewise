// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Field, Input, TextArea } from "./Field";

afterEach(cleanup);

describe("Input", () => {
  it("carries the shared box rather than redefining one", () => {
    const { container } = render(<Input size="sm" />);
    const el = container.querySelector("input")!;
    expect(el.className.split(" ")).toEqual(
      expect.arrayContaining(["ui-input", "ui-input--sm"]),
    );
  });

  it("keeps a placement class from the caller", () => {
    const { container } = render(<Input className="doc-search-input" />);
    const el = container.querySelector("input")!;
    expect(el.classList.contains("ui-input")).toBe(true);
    expect(el.classList.contains("doc-search-input")).toBe(true);
  });

  it("still behaves like an input", () => {
    const onChange = vi.fn();
    const { container } = render(<Input value="" onChange={onChange} />);
    fireEvent.change(container.querySelector("input")!, { target: { value: "x" } });
    expect(onChange).toHaveBeenCalled();
  });

  it("does not swallow the native type or placeholder", () => {
    const { container } = render(<Input type="search" placeholder="find" />);
    const el = container.querySelector("input")!;
    expect(el.type).toBe("search");
    expect(el.placeholder).toBe("find");
  });
});

describe("TextArea", () => {
  it("shares the box and adds its own growth rules", () => {
    const { container } = render(<TextArea />);
    const el = container.querySelector("textarea")!;
    expect(el.classList.contains("ui-input")).toBe(true);
    expect(el.classList.contains("ui-textarea")).toBe(true);
  });
});

describe("Field", () => {
  it("ties its label to the control it labels", () => {
    const { container } = render(
      <Field label="API key">{(props) => <Input {...props} />}</Field>,
    );
    const label = container.querySelector("label")!;
    const input = container.querySelector("input")!;
    expect(label.getAttribute("for")).toBe(input.id);
    expect(input.id).toBeTruthy();
  });

  it("describes the control with its hint, so a screen reader reads both", () => {
    const { container } = render(
      <Field label="Model" hint="Which model answers">
        {(props) => <Input {...props} />}
      </Field>,
    );
    const input = container.querySelector("input")!;
    const note = container.querySelector(".ui-field-note")!;
    expect(input.getAttribute("aria-describedby")).toBe(note.id);
    expect(note.textContent).toBe("Which model answers");
  });

  it("an error replaces the hint and marks the field", () => {
    const { container } = render(
      <Field label="Key" hint="not shown" error="That key was rejected">
        {(props) => <Input {...props} />}
      </Field>,
    );
    expect(container.querySelector(".ui-field-note")!.textContent).toBe(
      "That key was rejected",
    );
    expect(container.querySelector(".ui-field--error")).not.toBeNull();
  });

  it("adds no describedby when there is nothing to describe", () => {
    const { container } = render(<Field label="Key">{(props) => <Input {...props} />}</Field>);
    expect(container.querySelector("input")!.getAttribute("aria-describedby")).toBeNull();
  });
});
