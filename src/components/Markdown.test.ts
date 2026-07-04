import { describe, expect, it } from "vitest";
import { splitStreamingMarkdown } from "../components/Markdown";

describe("splitStreamingMarkdown", () => {
  it("keeps entire text as tail when no paragraph break", () => {
    expect(splitStreamingMarkdown("Hello world")).toEqual({
      stable: "",
      tail: "Hello world",
    });
  });

  it("splits at the last completed paragraph", () => {
    expect(splitStreamingMarkdown("First para.\n\nSecond line")).toEqual({
      stable: "First para.",
      tail: "Second line",
    });
  });

  it("uses the last paragraph boundary for long streams", () => {
    const text = "A\n\nB\n\nC streaming";
    expect(splitStreamingMarkdown(text)).toEqual({
      stable: "A\n\nB",
      tail: "C streaming",
    });
  });
});
