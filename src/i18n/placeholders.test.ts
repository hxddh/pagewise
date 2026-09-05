import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

/**
 * Every placeholder in every catalog must be one `interpolate` can fill.
 *
 * `interpolate` accepts `{{name}}` and nothing else. Eleven strings in each
 * catalog were written with single braces — "Step {step}", "Mark: {text}" —
 * and every one of them reached the screen verbatim: the 11.0 review saw
 * "第 {step} 步" in the running assistant's status line. Nothing failed, because
 * an unfilled placeholder is still a string.
 *
 * This walks both catalogs and fails on any brace that is not doubled, and on
 * any key present in one catalog and not the other.
 */
function flatten(obj: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (!obj || typeof obj !== "object") return out;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const SINGLE_BRACE = /(?<!\{)\{(\w+)\}(?!\})/g;

describe("translation placeholders", () => {
  const catalogs = { en: flatten(en), "zh-CN": flatten(zhCN) };

  for (const [name, strings] of Object.entries(catalogs)) {
    it(`${name}: uses only {{name}} placeholders`, () => {
      const offenders: string[] = [];
      for (const [key, value] of strings) {
        if (SINGLE_BRACE.test(value)) offenders.push(`${key}: ${value}`);
        SINGLE_BRACE.lastIndex = 0;
      }
      expect(offenders, "single-brace placeholders are never interpolated").toEqual([]);
    });
  }

  it("both catalogs carry the same keys", () => {
    const enKeys = [...catalogs.en.keys()].sort();
    const zhKeys = [...catalogs["zh-CN"].keys()].sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it("both catalogs name the same placeholders for each key", () => {
    const names = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    const mismatched: string[] = [];
    for (const [key, value] of catalogs.en) {
      const other = catalogs["zh-CN"].get(key);
      if (other === undefined) continue;
      if (names(value).join(",") !== names(other).join(",")) mismatched.push(key);
    }
    expect(mismatched).toEqual([]);
  });
});
