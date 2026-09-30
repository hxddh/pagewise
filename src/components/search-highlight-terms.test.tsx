// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { highlightTerms } from "./DocumentSearch";

describe("search results mark the words (16.0)", () => {
  it("wraps each searched word, whatever its case", () => {
    const { container } = render(<p>{highlightTerms("Revenue fell; revenue rose", "revenue")}</p>);
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Revenue", "revenue"]);
  });

  it("treats the query as text, not a pattern", () => {
    const { container } = render(<p>{highlightTerms("a (b) c", "(b)")}</p>);
    expect(container.querySelector("mark")?.textContent).toBe("(b)");
  });
});
