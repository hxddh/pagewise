import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import zhCN from "../i18n/locales/zh-CN.json";
import { classifyOpenError, openErrorMessage } from "./open-error";
import { sniffImageType } from "./file-type";

/**
 * An encrypted, damaged, oversize or unsupported file reaches the reader as a
 * translated message with a next step (24.0), not as Rust's English sentence.
 * The inputs are the coded messages `src-tauri/src/doc_check.rs` emits — its
 * own tests pin that each case produces its code.
 */

type Catalog = Record<string, unknown>;

function translator(catalog: Catalog) {
  return (key: string, vars?: Record<string, string | number>) => {
    const raw = key.split(".").reduce<unknown>((o, k) => (o as Catalog | undefined)?.[k], catalog);
    if (typeof raw !== "string") return key;
    return raw.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ""));
  };
}

const tEn = translator(en);
const tZh = translator(zhCN);

describe("why a file did not open", () => {
  it("says a password-protected PDF is one, and how to get past it", () => {
    const e = new Error("pdf-encrypted: PDF is encrypted");
    expect(classifyOpenError(e)).toEqual({ kind: "encrypted" });
    expect(openErrorMessage(e, tEn)).toBe(en.errors.pdfEncrypted);
    expect(openErrorMessage(e, tEn)).toMatch(/password/);
    expect(openErrorMessage(e, tZh)).toBe(zhCN.errors.pdfEncrypted);
    // pdf.js's own exception, should a file get past the extractor.
    const pdfjs = Object.assign(new Error("No password given"), { name: "PasswordException" });
    expect(classifyOpenError(pdfjs)?.kind).toBe("encrypted");
  });

  it("says a damaged PDF is damaged, from the raw string Tauri rejects with", () => {
    const raw = "pdf-damaged: Invalid PDF structure";
    expect(classifyOpenError(raw)).toEqual({ kind: "damaged" });
    expect(openErrorMessage(raw, tEn)).toBe(en.errors.pdfDamaged);
    expect(openErrorMessage(raw, tZh)).toBe(zhCN.errors.pdfDamaged);
    const pdfjs = Object.assign(new Error("Invalid PDF structure."), { name: "InvalidPDFException" });
    expect(classifyOpenError(pdfjs)?.kind).toBe("damaged");
  });

  it("gives an oversize file's size and the limit, in megabytes", () => {
    const e = new Error("file-too-large: 270131913 bytes; max 268435456");
    expect(classifyOpenError(e)).toEqual({ kind: "tooLarge", size: 270131913, max: 268435456 });
    const msg = openErrorMessage(e, tEn)!;
    expect(msg).toContain("258 MB");
    expect(msg).toContain("256 MB");
    expect(msg).not.toMatch(/\{\{/);
    expect(openErrorMessage(e, tZh)).toContain("258 MB");
    // Without a parseable detail, still the translated message.
    expect(openErrorMessage("file-too-large: ?", tEn)).toBe(en.errors.fileTooLargeUnknown);
  });

  it("says an unsupported type cannot be opened and names what can", () => {
    const e = new Error("unsupported-type: not a PDF or a supported image");
    expect(classifyOpenError(e)).toEqual({ kind: "unsupported" });
    expect(openErrorMessage(e, tEn)).toBe(en.errors.unsupportedFile);
    expect(openErrorMessage(e, tZh)).toBe(zhCN.errors.unsupportedFile);
    expect(tEn("errors.unsupportedDropped", { name: "report.docx" })).toContain("report.docx");
  });

  it("leaves every other error to the caller", () => {
    expect(classifyOpenError(new Error("path not authorized"))).toBeNull();
    expect(classifyOpenError("Read failed: permission denied")).toBeNull();
    expect(openErrorMessage(undefined, tEn)).toBeNull();
  });
});

describe("an image's type, from its bytes", () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, 0, 0, 0, 0, 0, 0, 0, 0]);

  it("reads the signature, not the name", () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageType(bytes(0x42, 0x4d))).toBe("image/bmp");
    expect(
      sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe("image/webp");
    // A ZIP (DOCX) is not an image.
    expect(sniffImageType(bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull();
  });
});
