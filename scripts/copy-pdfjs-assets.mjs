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

rmSync(destRoot, { recursive: true, force: true });
mkdirSync(join(destRoot, "cmaps"), { recursive: true });
mkdirSync(join(destRoot, "standard_fonts"), { recursive: true });
cpSync(join(pdfjsRoot, "cmaps"), join(destRoot, "cmaps"), { recursive: true });
cpSync(join(pdfjsRoot, "standard_fonts"), join(destRoot, "standard_fonts"), { recursive: true });
console.log("[copy-pdfjs-assets] copied cmaps + standard_fonts to public/pdfjs/");
