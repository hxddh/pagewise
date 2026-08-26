# Golden fixtures

`pdf-inspector` is intentionally not pinned to an exact version, so these
fixtures — not a version lock — are what guards behavior.

That was the intent and not the practice: the requirement read `"0.1"`, which
Cargo takes as `>=0.1.0, <0.2.0`, so it was a lock in everything but name.
Upstream published 1.0 and sixteen more minors that never arrived, and the
weekly drift job reported green throughout because `cargo update` obeys the
same ceiling. It reads `"1"` now, and the drift job compares against crates.io
directly so the next major cannot hide behind the range either.

Crossing that boundary moved nothing these fixtures can see: on all six, page
count, extracted characters, table detection, text-run count, `pdf_type`,
confidence and `pages_needing_ocr` were identical under 0.1.8 and 1.17.0. Assertions in
`src/inspect.rs` use tolerances: an upstream improvement that shifts extracted
text by a few percent must not fail CI, but losing table structure, scanned
detection, or link positions must.

| Fixture | Built from | Guards |
|---|---|---|
| `text-simple.pdf` | py-pdf/sample-files `002-trivial-libre-office-writer` | plain text extraction |
| `cjk-table.pdf` | Chromium `--print-to-pdf`, CJK + a 3×3 financial table | CJK decoding, and that table columns never run together |
| `scanned.pdf` | Chromium `--print-to-pdf`, a single image, no text layer | scanned classification routes to vision |
| `links-figure.pdf` | Chromium `--print-to-pdf`, two hyperlinks and one image | link URLs and figure boxes carry positions |
| `form-fields.pdf` | hand-built AcroForm with two filled text fields | filled form values reach the page text, so the assistant can read them |
| `damaged.pdf` | first 600 bytes of a valid PDF | a malformed file fails cleanly instead of panicking |
