import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A handful of CSS declarations the app is unusable without.
 *
 * jsdom has no layout engine, so the component tests cannot see any of this —
 * and every one of these has already broken in a shipped release:
 *
 * - 6.0.0 removed the page-edge click targets and merged their leftover
 *   selector onto `.anchored-popover`, so every dropdown in the app lost its
 *   background. The usage panel opened as transparent text over the
 *   conversation, and it stayed that way for four releases.
 * - 6.0.0 also sized the scroller with `flex: 1` inside a row flex container,
 *   which collapsed it to zero height: the document could not be scrolled.
 * - 6.2 clipped pages so a mark could not draw over its neighbour.
 *
 * These assertions are crude — they read the stylesheet as text — and that is
 * the point: they are the only thing standing between a careless edit and a
 * release where a whole surface is invisible.
 */

function rule(file, selector) {
  const css = readFileSync(new URL(`../src/styles/${file}`, import.meta.url), "utf8");
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `no rule for ${selector} in ${file}`).toBeGreaterThan(-1);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

describe("declarations the app cannot lose", () => {
  it("a popover has a surface of its own", () => {
    const popover = rule("preview.css", ".anchored-popover");
    expect(popover).toContain("background:");
    expect(popover).toContain("border:");
    // Scoped to a hover state is how this broke: a popover is not part of the
    // thing that opened it and cannot depend on the pointer being there.
    expect(popover).not.toContain(":hover");
  });

  it("the scrolling container has a height that does not depend on its content", () => {
    const scroller = rule("preview.css", ".pdf-scroller");
    expect(scroller).toContain("position: absolute");
    expect(scroller).toContain("inset: 0");
    expect(scroller).toContain("overflow: auto");
  });

  it("a page clips what is drawn on it", () => {
    expect(rule("preview.css", ".pdf-page-slot")).toContain("overflow: hidden");
  });

  it("the shared button and input carry a focus ring", () => {
    expect(rule("ui.css", ".ui-btn:focus-visible")).toContain("outline:");
    expect(rule("ui.css", ".ui-input:focus-visible")).toContain("outline:");
  });

  it("motion can be turned off", () => {
    const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
    expect(css).toContain("prefers-reduced-motion");
  });
});
