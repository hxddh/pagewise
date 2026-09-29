#!/usr/bin/env python3
"""Render every corpus page to an image, as a scanner would hand it over (14.0).

`npm run eval` calls this before the OCR suite: each document in eval/corpus
(and eval/corpus/fetched, when present) is rendered at 200 dpi — the
resolution PageWise renders a page at for OCR — into eval/out/scans/<id>/,
with a manifest of each page's visible box so recognised pixels can be put
back into absolute PDF space, the frame the extractor's runs are in.

Clean renders, not scanner noise: the real scan in the corpus (Vicksburg) is
what says how much worse the real thing is.

Usage: python3 eval/corpus/build_scans.py [--force]
"""
import json
import os
import sys

import pypdfium2 as pdfium

# The app's OCR_DPI. PW_OCR_DPI renders elsewhere, to measure another.
DPI = int(os.environ.get("PW_OCR_DPI", "200"))
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CORPUS = os.path.join(ROOT, "eval", "corpus")
OUT = os.path.join(ROOT, "eval", "out", "scans" if DPI == 200 else f"scans-{DPI}")


def corpus_files():
    for d in (CORPUS, os.path.join(CORPUS, "fetched")):
        if os.path.isdir(d):
            for f in sorted(os.listdir(d)):
                if f.endswith(".pdf"):
                    yield os.path.join(d, f)


def main():
    force = "--force" in sys.argv
    os.makedirs(OUT, exist_ok=True)
    manifest_path = os.path.join(OUT, "manifest.json")
    manifest = {}
    if os.path.exists(manifest_path) and not force:
        with open(manifest_path) as fh:
            manifest = json.load(fh)
    for path in corpus_files():
        doc_id = os.path.splitext(os.path.basename(path))[0]
        mtime = os.path.getmtime(path)
        entry = manifest.get(doc_id)
        if entry and entry.get("mtime") == mtime and entry.get("dpi") == DPI:
            continue
        pdf = pdfium.PdfDocument(path)
        out_dir = os.path.join(OUT, doc_id)
        os.makedirs(out_dir, exist_ok=True)
        pages = []
        for i in range(len(pdf)):
            page = pdf[i]
            # pdfium renders the crop box, rotated as displayed.
            left, bottom, right, top = page.get_cropbox()
            image = page.render(scale=DPI / 72).to_pil().convert("L")
            name = f"p{i + 1}.png"
            image.save(os.path.join(out_dir, name))
            pages.append(
                {
                    "page": i + 1,
                    "image": f"{doc_id}/{name}",
                    "origin": [left, bottom],
                    "height": top - bottom,
                    "rotation": page.get_rotation(),
                }
            )
        manifest[doc_id] = {"mtime": mtime, "dpi": DPI, "pages": pages}
        print(f"[scans] {doc_id}: {len(pages)} page(s)")
    with open(manifest_path, "w") as fh:
        json.dump(manifest, fh, indent=1)


if __name__ == "__main__":
    main()
