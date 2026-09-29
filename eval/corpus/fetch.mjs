#!/usr/bin/env node
/**
 * Fetch real third-party PDFs into `eval/corpus/fetched/`: `npm run eval:fetch`.
 *
 * The generated corpus controls its layout; these do not, which is their
 * point — they were made by producers nobody here chose. They are not
 * committed. Each comes from a published package archive pinned by SHA-256,
 * so every run measures the same bytes.
 *
 *   GeoBase_NHNC1_Data_Model_UML_EN.pdf  Government of Canada data model, 19
 *                                         pages, bilingual front matter, UML tables
 *   Seige_of_Vicksburg_Sample_OCR.pdf    a scanned 19th-century text with an
 *                                         OCR text layer, 6 pages
 *
 * Both ship as test resources in the pypdf source distribution. A document
 * carrying a named person or another publisher's "may not be reproduced"
 * notice is deliberately not taken from that archive, whatever its size.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, "fetched");

const SOURCES = [
  {
    url: "https://files.pythonhosted.org/packages/1f/ac/63d71aaedb59acbcdef491e6ca6469165e3771c9c74358204818fd9bc5a6/pypdf-6.19.0.tar.gz",
    sha256: "bbc43aca292369ccc6cbc8a921991ecf2538a3587ab5a116eff06c321d647155",
    root: "pypdf-6.19.0/resources",
    files: {
      "GeoBase_NHNC1_Data_Model_UML_EN.pdf": "geobase-data-model.pdf",
      "Seige_of_Vicksburg_Sample_OCR.pdf": "vicksburg-ocr.pdf",
    },
  },
];

mkdirSync(dest, { recursive: true });
for (const source of SOURCES) {
  const res = await fetch(source.url);
  if (!res.ok) throw new Error(`${source.url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== source.sha256) throw new Error(`${source.url}: sha256 ${digest}, expected ${source.sha256}`);
  const work = mkdtempSync(join(tmpdir(), "pw-fetch-"));
  const archive = join(work, "archive.tar.gz");
  writeFileSync(archive, bytes);
  const members = Object.keys(source.files).map((f) => `${source.root}/${f}`);
  execFileSync("tar", ["-xzf", archive, "-C", work, ...members]);
  for (const [from, to] of Object.entries(source.files)) {
    copyFileSync(join(work, source.root, from), join(dest, to));
    console.log(`fetched ${to}`);
  }
}
