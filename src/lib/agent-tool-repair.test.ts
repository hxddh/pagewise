import { describe, it, expect } from "vitest";
import { coerceNumericToolInput, normalizeRangeInput } from "./agent-tool-repair";

describe("coerceNumericToolInput", () => {
  it("coerces a single string-encoded numeric field", () => {
    expect(coerceNumericToolInput('{"page":"5"}')).toBe('{"page":5}');
  });

  it("coerces multiple numeric fields and leaves non-numeric fields untouched", () => {
    const out = coerceNumericToolInput('{"start":"2","end":"7","path":"/a.pdf"}');
    expect(JSON.parse(out!)).toEqual({ start: 2, end: 7, path: "/a.pdf" });
  });

  it("coerces maxChars and offset", () => {
    const out = coerceNumericToolInput('{"page":3,"offset":"120","maxChars":"6000"}');
    expect(JSON.parse(out!)).toEqual({ page: 3, offset: 120, maxChars: 6000 });
  });

  it("returns null when all numeric fields are already numbers", () => {
    expect(coerceNumericToolInput('{"page":5,"maxChars":6000}')).toBeNull();
  });

  it("returns null for non-numeric string values", () => {
    expect(coerceNumericToolInput('{"page":"abc"}')).toBeNull();
    expect(coerceNumericToolInput('{"page":""}')).toBeNull();
    expect(coerceNumericToolInput('{"page":"  "}')).toBeNull();
  });

  it("ignores unrelated string fields", () => {
    expect(coerceNumericToolInput('{"query":"invoice total"}')).toBeNull();
  });

  it("returns null for unparseable or non-object input", () => {
    expect(coerceNumericToolInput("not json")).toBeNull();
    expect(coerceNumericToolInput("[1,2,3]")).toBeNull();
    expect(coerceNumericToolInput("42")).toBeNull();
    expect(coerceNumericToolInput("null")).toBeNull();
  });
});

describe("normalizeRangeInput", () => {
  it("swaps an inverted range and drops the offset", () => {
    expect(normalizeRangeInput({ start: 9, end: 3, offset: 50 })).toEqual({
      start: 3,
      end: 9,
      offset: 0,
    });
  });

  it("leaves a valid range untouched", () => {
    const input = { start: 2, end: 8, offset: 40, maxChars: 6000 };
    expect(normalizeRangeInput(input)).toBe(input);
  });

  it("leaves a single-page range (start === end) untouched", () => {
    const input = { start: 4, end: 4 };
    expect(normalizeRangeInput(input)).toBe(input);
  });

  it("preserves other fields when swapping", () => {
    expect(
      normalizeRangeInput({ start: 6, end: 2, maxChars: 3000, path: "/a.pdf" }),
    ).toEqual({ start: 2, end: 6, offset: 0, maxChars: 3000, path: "/a.pdf" });
  });
});
