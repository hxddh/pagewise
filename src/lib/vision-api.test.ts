import { describe, expect, it } from "vitest";
import { imageBytesToDataUrl } from "./vision-api";

describe("imageBytesToDataUrl", () => {
  it("prefixes JPEG bytes with a data URL scheme", () => {
    const url = imageBytesToDataUrl(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]));
    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(url.includes("/9j/")).toBe(true);
  });
});
