import { describe, expect, it } from "vitest";
import { ERR_ENCRYPTED, isEncryptedPdfError } from "./pdf";

describe("isEncryptedPdfError", () => {
  it("recognizes the sentinel however Tauri surfaces it", () => {
    // invoke() rejects with a bare string; other paths wrap it in an Error.
    expect(isEncryptedPdfError(ERR_ENCRYPTED)).toBe(true);
    expect(isEncryptedPdfError(new Error(ERR_ENCRYPTED))).toBe(true);
    expect(isEncryptedPdfError(` ${ERR_ENCRYPTED}\n`)).toBe(true);
  });

  it("does not mistake other load failures for a locked document", () => {
    // A broken file must reach the user as a failure, not as a password box.
    expect(isEncryptedPdfError("PDF read failed: Invalid PDF structure")).toBe(false);
    expect(isEncryptedPdfError("File too large")).toBe(false);
    expect(isEncryptedPdfError(new Error("path not authorized"))).toBe(false);
    expect(isEncryptedPdfError(undefined)).toBe(false);
    expect(isEncryptedPdfError(null)).toBe(false);
  });

  it("does not match a message that merely mentions the sentinel", () => {
    expect(isEncryptedPdfError("PDF read failed: PDF_ENCRYPTED somewhere")).toBe(false);
  });
});
