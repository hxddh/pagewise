// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parsePageCacheKey } from "./pdf";

/**
 * A page-cache key has to survive the path inside it.
 *
 * The key is `path|page|scaleKey|quality|dpr`, and it was split from the left —
 * so a pipe anywhere in the filename shifted every field along, `parts[0]` was
 * a fragment of the path, and no comparison ever matched. A document whose name
 * contains a pipe (legal on Linux and macOS) re-rendered every page on every
 * scroll with its bitmaps sitting in the cache untouched.
 *
 * The last four fields have a known shape; the path does not. So it parses from
 * the right.
 */

const key = (path: string) => `${path}|7|w800|crisp|2`;

describe("parsePageCacheKey", () => {
  it("reads an ordinary path", () => {
    expect(parsePageCacheKey(key("/docs/report.pdf"))).toEqual({
      path: "/docs/report.pdf",
      page: "7",
      scaleKey: "w800",
      quality: "crisp",
      dpr: "2",
    });
  });

  it("keeps a path that contains the separator whole", () => {
    expect(parsePageCacheKey(key("/docs/a|b.pdf"))?.path).toBe("/docs/a|b.pdf");
    expect(parsePageCacheKey(key("/docs/a|b.pdf"))?.page).toBe("7");
  });

  it("survives several separators", () => {
    const path = "/x|y|z/notes|2024.pdf";
    const parsed = parsePageCacheKey(key(path));
    expect(parsed?.path).toBe(path);
    expect(parsed?.dpr).toBe("2");
  });

  it("does not confuse two documents whose keys share a prefix", () => {
    const a = parsePageCacheKey(key("/docs/a|b.pdf"));
    const b = parsePageCacheKey(key("/docs/a"));
    expect(a?.path).not.toBe(b?.path);
  });

  it("refuses a key with too few fields", () => {
    expect(parsePageCacheKey("/docs/report.pdf|7|w800")).toBeNull();
    expect(parsePageCacheKey("")).toBeNull();
  });
});
