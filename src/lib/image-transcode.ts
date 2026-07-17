/**
 * Media types every OpenAI-compatible vision/chat endpoint accepts. TIFF and
 * BMP are openable as documents (WebKit decodes both natively on macOS), but
 * providers reject their data URLs — transcode those to PNG before sending.
 */
const PROVIDER_SAFE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export async function ensureProviderCompatibleImage(
  bytes: Uint8Array,
  mediaType: string,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  if (PROVIDER_SAFE_IMAGE_TYPES.has(mediaType)) return { bytes, mediaType };

  const blob = new Blob([bytes as BlobPart], { type: mediaType });
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
        "image/png",
      );
    });
    return { bytes: new Uint8Array(await png.arrayBuffer()), mediaType: "image/png" };
  } finally {
    bitmap.close();
  }
}
