/**
 * Why a file did not open, in the reader's language, with what to do next
 * (24.0).
 *
 * Until 24.0 an encrypted PDF showed the extractor's own "PDF is encrypted",
 * a damaged one "PDF read failed: Invalid PDF structure", and a file over the
 * size cap opened and then said "File too large" on every page. Rust now
 * leads each of those refusals with a stable code (`src-tauri/src/doc_check.rs`,
 * `"<code>: <detail>"`); this turns the code into a message. pdf.js's own
 * exceptions are read too, in case a file gets past the extractor and not
 * past the renderer.
 */

export type OpenErrorKind = "encrypted" | "damaged" | "tooLarge" | "unsupported";

export interface OpenError {
  kind: OpenErrorKind;
  /** For `tooLarge`: the file's size and the cap, in bytes, when known. */
  size?: number;
  max?: number;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** The codes `doc_check.rs` emits. Keep the two lists the same. */
const CODES: Record<string, OpenErrorKind> = {
  "pdf-encrypted": "encrypted",
  "pdf-damaged": "damaged",
  "file-too-large": "tooLarge",
  "unsupported-type": "unsupported",
};

/** pdf.js exception names (`PasswordException`, `InvalidPDFException`). */
const PDFJS_NAMES: Record<string, OpenErrorKind> = {
  PasswordException: "encrypted",
  InvalidPDFException: "damaged",
};

function rawMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "";
}

export function classifyOpenError(e: unknown): OpenError | null {
  if (e instanceof Error && PDFJS_NAMES[e.name]) return { kind: PDFJS_NAMES[e.name] };
  const raw = rawMessage(e);
  if (raw === "errors.unsupportedFile") return { kind: "unsupported" };
  const match = /^([a-z]+(?:-[a-z]+)+):\s*(.*)$/s.exec(raw);
  const kind = match ? CODES[match[1]] : undefined;
  if (!kind) return null;
  if (kind !== "tooLarge") return { kind };
  const sizes = /(\d+) bytes; max (\d+)/.exec(match![2]);
  return sizes ? { kind, size: Number(sizes[1]), max: Number(sizes[2]) } : { kind };
}

const MIB = 1024 * 1024;

/** Whole megabytes: "258 MB" reads better than a byte count. */
function megabytes(bytes: number): string {
  return `${Math.round(bytes / MIB)} MB`;
}

/** The translated message for an open failure, or null when it is not one of these. */
export function openErrorMessage(e: unknown, t: Translate): string | null {
  const err = classifyOpenError(e);
  if (!err) return null;
  switch (err.kind) {
    case "encrypted":
      return t("errors.pdfEncrypted");
    case "damaged":
      return t("errors.pdfDamaged");
    case "tooLarge":
      return err.size !== undefined && err.max !== undefined
        ? t("errors.fileTooLarge", { size: megabytes(err.size), max: megabytes(err.max) })
        : t("errors.fileTooLargeUnknown");
    case "unsupported":
      return t("errors.unsupportedFile");
  }
}
