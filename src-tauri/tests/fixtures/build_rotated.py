#!/usr/bin/env python3
"""Build `rotated.pdf`: `python3 src-tauri/tests/fixtures/build_rotated.py`.

Four Letter pages with the same 40 numbered lines, carrying `/Rotate` 0, 90,
180 and 270 — what a reader writes when a page is turned and the file saved:
the MediaBox and the content stream stay as they were, only `/Rotate` is
added. (24.0)

A fifth page is the shape ReportLab's `setPageRotation(90)` writes, which is
what the v24 evaluation's `rot90.pdf` was: the MediaBox swapped to
`[0 0 792 612]` while the same portrait content is drawn, so lines 0-6 sit
above the top of the box. No renderer draws them, and the page text leaves
them out too; this page pins that the model is given what the reader sees.

Written byte by byte with no dependencies, so a rebuild is identical.
"""
from pathlib import Path

# (MediaBox, /Rotate) per page.
PAGES = (
    ("0 0 612 792", 0),
    ("0 0 612 792", 90),
    ("0 0 612 792", 180),
    ("0 0 612 792", 270),
    ("0 0 792 612", 90),
)
LINES = 40


def content(page: int) -> bytes:
    ops = ["BT", "/F1 11 Tf"]
    for line in range(LINES):
        ops.append(f"1 0 0 1 72 {720 - line * 16} Tm (Page {page} body text about revenue of {page * 7} dollars. line {line}) Tj")
    ops.append("ET")
    return ("\n".join(ops) + "\n").encode("ascii")


def build() -> bytes:
    page_ids = [3 + 2 * i for i in range(len(PAGES))]
    font_id = 3 + 2 * len(PAGES)
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: f"<< /Type /Pages /Kids [{' '.join(f'{i} 0 R' for i in page_ids)}] /Count {len(page_ids)} >>".encode(),
        font_id: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    }
    for n, (page_id, (media, rotate)) in enumerate(zip(page_ids, PAGES), start=1):
        stream = content(n)
        objects[page_id] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [{media}] /Rotate {rotate} "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {page_id + 1} 0 R >>"
        ).encode()
        objects[page_id + 1] = f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"endstream"

    out = bytearray(b"%PDF-1.4\n")
    offsets = {}
    for oid in sorted(objects):
        offsets[oid] = len(out)
        out += f"{oid} 0 obj\n".encode() + objects[oid] + b"\nendobj\n"
    xref = len(out)
    size = max(objects) + 1
    out += f"xref\n0 {size}\n0000000000 65535 f \n".encode()
    for oid in range(1, size):
        out += f"{offsets[oid]:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


if __name__ == "__main__":
    (Path(__file__).resolve().parent / "rotated.pdf").write_bytes(build())
