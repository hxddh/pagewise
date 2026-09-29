import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pdfjsRoot = join(root, "node_modules", "pdfjs-dist");
const destRoot = join(root, "public", "pdfjs");

if (!existsSync(pdfjsRoot)) {
  console.warn("[copy-pdfjs-assets] pdfjs-dist not installed — skipping");
  process.exit(0);
}

// `wasm/` holds the JPEG 2000 and JBIG2 decoders and the colour-management
// module; `iccs/` the predefined ICC profiles. Scanned PDFs are exactly the
// files that use JPEG 2000 and JBIG2, and without these pdf.js falls back to
// slower or incomplete decoding — they were never copied before 13.1.
const ASSET_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];

rmSync(destRoot, { recursive: true, force: true });
for (const dir of ASSET_DIRS) {
  if (!existsSync(join(pdfjsRoot, dir))) continue;
  mkdirSync(join(destRoot, dir), { recursive: true });
  cpSync(join(pdfjsRoot, dir), join(destRoot, dir), { recursive: true });
}
console.log(`[copy-pdfjs-assets] copied ${ASSET_DIRS.join(" + ")} to public/pdfjs/`);
