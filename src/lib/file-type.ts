/**
 * An image's media type from its first bytes (24.0).
 *
 * The type sent with an image document used to come from its extension, so a
 * JPEG saved as `.png` went to the provider labelled `image/png` and a BMP
 * named `.jpg` skipped the transcode providers need. Rust decides whether a
 * file is a document by the same signatures (`src-tauri/src/doc_check.rs`).
 */
export function sniffImageType(bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif"; // "GIF8"
  if (
    starts(0x52, 0x49, 0x46, 0x46) && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // "WEBP"
  ) {
    return "image/webp";
  }
  if (starts(0x42, 0x4d)) return "image/bmp"; // "BM"
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return "image/tiff";
  return null;
}
