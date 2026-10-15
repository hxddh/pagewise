import { describe, expect, it } from "vitest";
import { issueUrl, ISSUES_URL, platformName } from "./report-issue";

describe("report a problem (v23)", () => {
  it("carries the version, the platform and the language", () => {
    const url = new URL(issueUrl({ version: "21.2.0", platform: "macOS", locale: "zh-CN" }));
    expect(`${url.origin}${url.pathname}`).toBe(ISSUES_URL);
    expect(url.searchParams.get("body")).toContain("PageWise 21.2.0 · macOS · zh-CN");
  });

  it("carries nothing else: no path, no file name, no user agent", () => {
    const url = issueUrl({ version: "21.2.0", platform: platformName(navigatorLike), locale: "en" });
    expect(url).not.toMatch(/\.pdf|Users|home|Mozilla|AppleWebKit/i);
    expect([...new URL(url).searchParams.keys()].sort()).toEqual(["body", "template"]);
  });

  it("names the OS family only", () => {
    expect(platformName(navigatorLike)).toBe("macOS");
    expect(platformName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows");
    expect(platformName("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Linux");
    expect(platformName("")).toBe("unknown");
  });
});

const navigatorLike = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
