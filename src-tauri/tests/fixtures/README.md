# Golden fixtures

`pdf-inspector` is intentionally not pinned to an exact version, so these
fixtures — not a version lock — are what guards behavior. Assertions in
`src/inspect.rs` use tolerances: an upstream improvement that shifts extracted
text by a few percent must not fail CI, but losing table structure, scanned
detection, or link positions must.

| Fixture | Built from | Guards |
|---|---|---|
| `text-simple.pdf` | py-pdf/sample-files `002-trivial-libre-office-writer` | plain text extraction |
| `cjk-table.pdf` | Chromium `--print-to-pdf`, CJK + a 3×3 financial table | CJK decoding, and that table columns never run together |
| `scanned.pdf` | Chromium `--print-to-pdf`, a single image, no text layer | scanned classification routes to vision |
| `links-figure.pdf` | Chromium `--print-to-pdf`, two hyperlinks and one image | link URLs and figure boxes carry positions |
| `damaged.pdf` | first 600 bytes of a valid PDF | a malformed file fails cleanly instead of panicking |
