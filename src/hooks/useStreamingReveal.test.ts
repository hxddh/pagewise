import { describe, expect, it } from "vitest";
import { splitStreamSegments } from "../hooks/useStreamingReveal";

describe("splitStreamSegments", () => {
  it("splits CJK text into multiple segments", () => {
    const segments = splitStreamSegments("文中有哪些日期");
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.join("")).toBe("文中有哪些日期");
  });

  it("splits latin words", () => {
    const segments = splitStreamSegments("hello world");
    expect(segments.join("")).toBe("hello world");
    expect(segments.length).toBeGreaterThanOrEqual(2);
  });
});
