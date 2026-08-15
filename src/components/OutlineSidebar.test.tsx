// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutlineSidebar } from "./OutlineSidebar";
import type { DocHeading } from "../lib/types";

vi.mock("../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const outline = (levels: number[]): DocHeading[] =>
  levels.map((level, i) => ({ title: `Heading ${i + 1}`, page: 1, level }));

/** The depth each row is drawn at, read off the custom property the CSS uses. */
function depths(levels: number[]): number[] {
  const { container } = render(
    <OutlineSidebar outline={outline(levels)} currentPage={1} tabs={null} onPageSelect={() => {}} />,
  );
  return [...container.querySelectorAll<HTMLElement>(".outline-item")].map((el) =>
    Number(el.style.getPropertyValue("--outline-depth")),
  );
}

/**
 * How far each heading is indented.
 *
 * The stylesheet carried a single `.level-2` rule, so a heading at level 3 or
 * deeper matched nothing and inherited level 1's padding — measured at 64px for
 * levels 1, 3, 4 and 5 alike. A document with three heading levels had an
 * outline that read as flat, which is the one thing an outline is for.
 *
 * jsdom has no layout engine, so this asserts the depth the row is given rather
 * than the pixels it becomes; the arithmetic from depth to padding is one line
 * of CSS, and the geometry was verified once with the screenshot harness
 * (8, 20, 32, 44, 56px for levels 1 to 5).
 */
describe("outline indentation", () => {
  it("gives every level its own depth, not just the second", () => {
    expect(depths([1, 2, 3, 4, 5])).toEqual([0, 1, 2, 3, 4]);
  });

  it("stops indenting past the depth a 160px sidebar can carry", () => {
    // PDF outlines nest as deep as their author liked. Uncapped, the title
    // would be pushed out of the sidebar entirely.
    expect(depths([6, 9, 40])).toEqual([4, 4, 4]);
  });

  it("treats a malformed level as top level rather than a negative indent", () => {
    // `level` comes from the document, not from us.
    expect(depths([0, -3, 1])).toEqual([0, 0, 0]);
  });
});
