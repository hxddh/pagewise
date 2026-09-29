#!/usr/bin/env node
/**
 * Build the evaluation corpus: `node eval/corpus/build.mjs`.
 *
 * WHY GENERATED, AND WHY TWO TYPESETTERS. What decides whether a verbatim
 * quote can be found again is not the words but how the PDF producer laid them
 * out: justified lines broken mid-word, two columns, running headers, tables,
 * CJK with no spaces between words, ligatures, curly quotes. Every document
 * here is built from text whose licence allows redistribution (the GNU and
 * Mozilla licences permit verbatim copies; the two `*.html` sources were
 * written for this corpus and are MIT like the rest of the repository), and is
 * set by two unrelated PDF producers: Chromium's print pipeline (Skia), here,
 * and ReportLab, in `build_reportlab.py`.
 *
 * English text gets soft hyphens from the `hyphen` package, because Chromium
 * does not hyphenate here without system dictionaries — and a word broken
 * across a line ("reve-" / "nue") is the case the 11.0 review named as the
 * way a true citation was reported absent.
 *
 * The built PDFs are committed, so running the evaluation needs neither
 * Chromium nor ReportLab. Rebuild only when a source changes.
 *
 * Third-party documents that are real rather than generated are not committed;
 * see `fetch.mjs`.
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import hyphenEn from "hyphen/en/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => join(here, "src", f);
const out = (f) => join(here, f);
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A plain-text licence as HTML: paragraphs split on blank lines, hyphenated. */
function licenceHtml(file, title, css) {
  const text = readFileSync(src(file), "utf8");
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .map((p) => `<p>${hyphenEn.hyphenateSync(escape(p))}</p>`)
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>${css}</style></head><body>${paras}</body></html>`;
}

async function chromiumPdf(html, file, pdfOptions = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.pdf({ path: out(file), preferCSSPageSize: true, printBackground: true, ...pdfOptions });
  await browser.close();
}

const footer = `<div style="font-size:8px;width:100%;text-align:center;font-family:serif">
  <span class="pageNumber"></span></div>`;
const header = (t) => `<div style="font-size:7px;width:100%;text-align:right;padding-right:0.75in;font-family:serif">${t}</div>`;

// 1. Chinese contract, Chromium: CJK justified text, two tables, page breaks.
const contract = readFileSync(src("contract-zh.html"), "utf8");
await chromiumPdf(contract, "contract-zh.pdf", {
  displayHeaderFooter: true,
  headerTemplate: header("PW-EVAL-2025-0417"),
  footerTemplate: footer,
});

// 2. English paper, Chromium: two columns, justified, soft hyphens, ligature-prone
//    words, curly quotes, sub/superscripts.
const paper = readFileSync(src("paper-en.html"), "utf8").replace(
  /(<div class="cols">)([\s\S]*)(<\/div>\s*<\/body>)/,
  (_, a, body, z) => a + hyphenEn.hyphenateHTMLSync(body) + z,
);
await chromiumPdf(paper, "paper-en.pdf", {
  displayHeaderFooter: true,
  headerTemplate: header("Adaptive Admission for Small Object Caches"),
  footerTemplate: footer,
});

// 3. MPL-2.0 in Chromium, two narrow columns with running header and folio.
await chromiumPdf(
  licenceHtml(
    "mpl-2.0.txt",
    "Mozilla Public License 2.0",
    "@page{size:A4;margin:20mm 16mm} body{font-family:'DejaVu Sans',sans-serif;font-size:8.6pt;" +
      "column-count:2;column-gap:7mm;text-align:justify;line-height:1.35} p{margin:0 0 4pt}",
  ),
  "mpl-2.0.pdf",
  { displayHeaderFooter: true, headerTemplate: header("Mozilla Public License, v. 2.0"), footerTemplate: footer },
);

console.log("corpus built");
