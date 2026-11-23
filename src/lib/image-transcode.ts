/**
 * Media types every OpenAI-compatible vision/chat endpoint accepts. TIFF and
 * BMP are openable as documents (WebKit decodes both natively on macOS), but
 * providers reject their data URLs — transcode those before sending, and cap
 * multi-megapixel standalone images at `maxEdge` so 12MP+ scans never blow up
 * into 20–40 MB base64 request bodies (30.0).
 */
const PROVIDER_SAFE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const DEFAULT_MAX_IMAGE_EDGE = 1_568;
const SAFE_PASSTHROUGH_MAX_BYTES = 1_600_000;

export async function ensureProviderCompatibleImage(
  bytes: Uint8Array,
  mediaType: string,
  maxEdge: number = DEFAULT_MAX_IMAGE_EDGE,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const isSafeType = PROVIDER_SAFE_IMAGE_TYPES.has(mediaType);
  if (
    isSafeType &&
    bytes.byteLength <= SAFE_PASSTHROUGH_MAX_BYTES &&
    typeof createImageBitmap !== "function"
  ) {
    return { bytes, mediaType };
  }
  if (isSafeType && bytes.byteLength <= SAFE_PASSTHROUGH_MAX_BYTES) {
    try {
      const probe = await createImageBitmap(new Blob([bytes as BlobPart], { type: mediaType }));
      const fits = probe.width <= maxEdge && probe.height <= maxEdge;
      probe.close();
      if (fits) return { bytes, mediaType };
    } catch {
      return { bytes, mediaType };
    }
  }
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return { bytes, mediaType: isSafeType ? mediaType : "image/png" };
  }

  const blob = new Blob([bytes as BlobPart], { type: mediaType });
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  try {
    const largest = Math.max(bitmap.width, bitmap.height, 1);
    const scale = largest > maxEdge ? maxEdge / largest : 1;
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const outType = scale < 1 && mediaType !== "image/png" ? "image/jpeg" : isSafeType ? "image/jpeg" : "image/png";
    const encoded = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
        outType,
        outType === "image/jpeg" ? 0.86 : undefined,
      );
    });
    return { bytes: new Uint8Array(await encoded.arrayBuffer()), mediaType: outType };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    bitmap.close();
  }
}
