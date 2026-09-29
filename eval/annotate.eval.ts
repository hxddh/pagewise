/**
 * Does evidence written into the PDF land on the words it is evidence for? (14.1)
 *
 * The export writes each located finding as a Highlight annotation. A PDF
 * reader draws it from the annotation's QuadPoints and nothing else — no
 * PageWise, no text runs — so the question is whether those quads cover
 * exactly the quoted words, read the way a reader would read them.
 *
 * Quotes are the same ones `location.eval.ts` locates. Each located quote is
 * written with `annotate.rs` (through `eval/extract --annotate`, the app's own
 * code), the file is reopened with pdf.js, and the annotation is read back
 * through `readableAnnotations` — the code PageWise uses to show other
 * people's notes. Two things are checked per quote:
 *
 *   - the annotation is there, a Highlight, with the contents written;
 *   - the text pdf.js finds under its quads (`overlaidText`, what a reader
 *     copies from a highlight) contains the quote.
 *
 * No model is involved.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { locateQuote } from "../src/lib/quote-locate";
import { readableAnnotations } from "../src/lib/pdf-annotations";
import { corpusFiles, CORPUS, loadDoc, OUT, ROOT } from "./lib/corpus";
import { quotesFor } from "./lib/quotes";

const BIN = join(ROOT, "eval/extract/target/release/pagewise-eval-extract");
const PDFJS = join(ROOT, "node_modules/pdfjs-dist");
const FONTS = `${join(PDFJS, "standard_fonts")}/`;
const CMAPS = `${join(PDFJS, "cmaps")}/`;
const DIR = join(OUT, "annotated");

/** Letters and digits only, lower-cased: how a reader compares copied text. */
const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export const ANNOTATE_GATES = { present: 1, covered: 0.97 };

async function pdfjs() {
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const require = createRequire(import.meta.url);
  lib.GlobalWorkerOptions.workerSrc = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  return lib;
}

describe("evidence written into the PDF", () => {
  it("lands on the quoted words, and reads back", async () => {
    mkdirSync(DIR, { recursive: true });
    const lib = await pdfjs();
    // The generated corpus: documents whose text is known to extract cleanly,
    // so a miss here is the export's, not the extractor's.
    const files = corpusFiles().filter((f) => !f.includes(join(CORPUS, "fetched")));

    let written = 0;
    let present = 0;
    let covered = 0;
    const misses: string[] = [];
    const rows: string[] = [];

    for (const file of files) {
      const doc = loadDoc(file);
      const annotations: Array<Record<string, unknown>> = [];
      const expected = new Map<string, { page: number; quote: string }>();
      for (const q of quotesFor(doc)) {
        if (q.kind === "cell") continue;
        const items = doc.pages.find((p) => p.page === q.page)?.items ?? [];
        const outcome = locateQuote(items, q.text);
        if (outcome.status !== "located") continue;
        const id = `q${annotations.length}`;
        annotations.push({
          id,
          page: q.page,
          rects: outcome.rects,
          frame: "pdf",
          contents: `claim ${id}`,
          author: "PageWise",
          subject: "Finding",
          color: [0.55, 0.36, 0.96],
        });
        expected.set(`claim ${id}`, { page: q.page, quote: q.text });
      }
      const json = join(DIR, `${doc.id}.json`);
      const out = join(DIR, `${doc.id}.pdf`);
      writeFileSync(json, JSON.stringify(annotations));
      const n = Number(execFileSync(BIN, ["--annotate", file, out, json]).toString().trim());
      written += n;

      // The font data the app hands pdf.js too (`pdfDocumentInit`); without
      // it pdf.js cannot place the standard 14 fonts' glyphs, and every
      // highlight over them reads back empty.
      const task = lib.getDocument({ url: out, verbosity: 0, standardFontDataUrl: FONTS, cMapUrl: CMAPS, cMapPacked: true });
      const pdf = await task.promise;
      const seen = new Set<string>();
      let docCovered = 0;
      for (let page = 1; page <= pdf.numPages; page++) {
        const raw = await (await pdf.getPage(page)).getAnnotations();
        for (const a of readableAnnotations(raw, page)) {
          const want = expected.get(a.contents);
          if (!want || a.subtype !== "Highlight" || want.page !== page) continue;
          seen.add(a.contents);
          if (fold(a.quoted).includes(fold(want.quote))) docCovered += 1;
          else if (misses.length < 20) misses.push(`${doc.id} p${page}: "${want.quote}" → "${a.quoted}"`);
        }
      }
      await task.destroy();
      present += seen.size;
      covered += docCovered;
      rows.push(`| ${doc.id} | ${n} | ${seen.size} | ${docCovered} |`);
    }

    console.log(
      ["| document | written | read back | text under the highlight is the quote |", "|---|---:|---:|---:|", ...rows,
        `| **all** | ${written} | ${present} | **${covered}** (${((100 * covered) / Math.max(1, present)).toFixed(1)}%) |`].join("\n"),
    );
    for (const m of misses) console.log(`  ${m}`);
    writeFileSync(join(OUT, "annotate.json"), JSON.stringify({ written, present, covered, misses }, null, 2));

    expect(written).toBeGreaterThan(300);
    expect(present / written).toBeGreaterThanOrEqual(ANNOTATE_GATES.present);
    expect(covered / present).toBeGreaterThanOrEqual(ANNOTATE_GATES.covered);
  });
});
