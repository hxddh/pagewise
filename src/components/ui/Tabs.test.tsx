// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Tabs } from "./Tabs";

afterEach(cleanup);

const items = [
  { id: "pages" as const, label: "Pages" },
  { id: "outline" as const, label: "Outline", disabled: true },
  { id: "notes" as const, label: "Notes" },
];

describe("Tabs", () => {
  it("is a tablist of tabs, with one of them selected", () => {
    const view = render(<Tabs items={items} value="pages" onChange={() => {}} />);
    expect(view.getAllByRole("tab")).toHaveLength(3);
    expect(view.getByRole("tab", { name: "Pages" }).getAttribute("aria-selected")).toBe("true");
    expect(view.getByRole("tab", { name: "Notes" }).getAttribute("aria-selected")).toBe("false");
  });

  it("walks the strip with the arrow keys, skipping a disabled tab", () => {
    // Reachability is Tab's job, and every tab is in the tab order. This is the
    // tablist behaviour a keyboard user expects on top of that.
    const onChange = vi.fn();
    const view = render(<Tabs items={items} value="pages" onChange={onChange} />);

    const pages = view.getByRole("tab", { name: "Pages" });
    pages.focus();
    fireEvent.keyDown(pages, { key: "ArrowRight" });
    // Outline is disabled and has nothing behind it: the cursor goes past it.
    expect(onChange).toHaveBeenLastCalledWith("notes");
    expect(document.activeElement).toBe(view.getByRole("tab", { name: "Notes" }));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("pages");
    expect(document.activeElement).toBe(pages);
  });

  it("jumps to the ends with Home and End", () => {
    const onChange = vi.fn();
    const view = render(<Tabs items={items} value="notes" onChange={onChange} />);
    const notes = view.getByRole("tab", { name: "Notes" });
    notes.focus();

    fireEvent.keyDown(notes, { key: "Home" });
    expect(document.activeElement).toBe(view.getByRole("tab", { name: "Pages" }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(notes);
  });

  it("leaves other keys alone", () => {
    const onChange = vi.fn();
    const view = render(<Tabs items={items} value="pages" onChange={onChange} />);
    const pages = view.getByRole("tab", { name: "Pages" });
    fireEvent.keyDown(pages, { key: "Tab" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
