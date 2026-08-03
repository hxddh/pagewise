import { describe, expect, it } from "vitest";
import { displayUrl, isSafeLink, schemeOf } from "./safe-link";

describe("isSafeLink", () => {
  it("allows the schemes a browser should handle", () => {
    expect(isSafeLink("https://example.com/spec")).toBe(true);
    expect(isSafeLink("http://example.com")).toBe(true);
    expect(isSafeLink("mailto:someone@example.com")).toBe(true);
  });

  it("refuses schemes that execute or read the machine", () => {
    // These arrive from documents and from model output — neither is trusted.
    expect(isSafeLink("javascript:alert(1)")).toBe(false);
    expect(isSafeLink("file:///etc/passwd")).toBe(false);
    expect(isSafeLink("data:text/html,<script>")).toBe(false);
    expect(isSafeLink("vbscript:msgbox")).toBe(false);
  });

  it("refuses a relative link, which has no host to judge", () => {
    // Resolved against the app's own origin, so it is not an external link.
    expect(isSafeLink("/etc/passwd")).toBe(false);
    expect(isSafeLink("../secrets")).toBe(false);
  });

  it("refuses empty and malformed input rather than throwing", () => {
    expect(isSafeLink("")).toBe(false);
    expect(isSafeLink("   ")).toBe(false);
    expect(isSafeLink("http://[")).toBe(false);
  });

  it("is not fooled by case or leading whitespace in the scheme", () => {
    expect(isSafeLink("HTTPS://example.com")).toBe(true);
    expect(isSafeLink("JavaScript:alert(1)")).toBe(false);
  });
});

describe("schemeOf", () => {
  it("reports the protocol, or null when there is none to read", () => {
    expect(schemeOf("https://example.com")).toBe("https:");
    expect(schemeOf("http://[")).toBeNull();
  });
});

describe("displayUrl", () => {
  it("leaves a short URL alone", () => {
    expect(displayUrl("https://example.com")).toBe("https://example.com");
  });

  it("keeps the host visible when shortening", () => {
    const long = `https://example.com/${"a".repeat(200)}`;
    const shown = displayUrl(long);
    expect(shown.startsWith("https://example.com/")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(72);
    expect(shown.endsWith("…")).toBe(true);
  });
});
