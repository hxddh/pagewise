import { describe, expect, it } from "vitest";
import { isImeComposing } from "./ime";

describe("isImeComposing", () => {
  it("detects nativeEvent.isComposing", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: true, keyCode: 13 } })).toBe(true);
  });

  it("detects Safari/WKWebView composition-end keyCode 229", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  it("allows ordinary Enter and Escape events through", () => {
    expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(false);
    expect(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 27 } })).toBe(false);
    expect(isImeComposing(null)).toBe(false);
  });
});
