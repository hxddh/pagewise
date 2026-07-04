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

  it("does not split inside fenced code blocks", () => {
    const text = "```python\nline1\n\nline2\n```\n\nAfter";
    expect(splitStreamingMarkdown(text)).toEqual({
      stable: "```python\nline1\n\nline2\n```",
      tail: "After",
    });
  });
});
