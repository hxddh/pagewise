# Evaluation

What PageWise can be measured on without a person in the loop. Started in 13.0,
because every earlier design note ended with some version of "the model's
behaviour cannot be verified in this repository".

```bash
npm run eval:fetch   # optional: real third-party PDFs, pinned by SHA-256, not committed
npm run eval         # builds eval/extract (Rust) on first run, then measures
```

## What is measured

| Suite | Question | Gate |
|---|---|---|
| `location.eval.ts` | A quote copied verbatim from the page text the assistant reads — is it found among the page's text runs, where a citation is checked? | ≥ 90% located |
| `location.eval.ts` | The same quotes, each altered the way a careless or fabricating model would (a digit, two words swapped, a "not", a letter) — are they refused? | ≤ 1% wrongly located |
| `search.eval.ts` | Asked in the reader's words rather than the document's, does `search_in_document` put the right page in its first three? | ≥ 80%, and never worse than exact search on any question |
| `ocr.eval.ts` | Every page rendered to an image and read by the local OCR the app ships (14.0) — are the same quotes found among the recognised words? | English single-column ≥ 95%, Chinese prose ≥ 85%, generated corpus ≥ 80%, altered quotes ≤ 1% wrongly located, median ≤ 5 s a page |
| `annotate.eval.ts` | Located quotes written into the PDF as highlights by the app's export code (14.1), read back with pdf.js — is each there, and is the quote the text under it? | all read back, ≥ 97% with the quote under the highlight (measured 626 of 629) |
| `numbers.eval.ts` | Corpus sentences stating a quantity, cited and read against their passage (15.0): honest and reworded claims must not be flagged; claims with one number changed should be | ≤ 0.5% false alarms (measured 0 of 231), ≥ 85% caught (measured 94.0%) |
| `live-score.eval.ts` | Recorded answers from real models (below): how many cite, how many quotes are on their pages, how many cite a right page — and every sentence through the app's own sentence table (20.0): sentences, marked, verified, unchecked, and how many unchecked sentences' numbers the text they cite states. | none — it measures models, not this repository |

No model is called by the gated suites. The quotes are cut from exactly the text
the model is given, so a miss is one the model could not have avoided by copying
more carefully. Right pages for search questions are derived from the wording the
answer rests on (`questions.ts`), never written down by hand.

Results at 13.0.0:

| | before | after |
|---|---:|---:|
| verbatim quotes located (generated corpus, 662) | 78.5% | 99.4% |
| verbatim quotes located (with fetched documents, 1,041) | — | 98.0% |
| altered quotes wrongly located (2,040) | — | 0.1% |
| search: right page first (36 questions) | 1 | 27 |
| search: right page in first three | 1 | 32 |

Results at 20.0, on scanned pages (`ocr.eval.ts`; pages rendered by
`corpus/build_scans.py` at the app's resolution, 200 dpi for English and 300
for Chinese; recognition cached in `eval/out/ocr*/`). Measured 2026-10-15 on
the 20.0 tree at commit `cdd9684`:

```bash
rm -rf eval/out/ocr eval/out/ocr-300   # fresh recognition; without this the cached times are re-scored
npm run eval                           # add -- --disableConsoleIntercept to print the table
```

The recognition path has not changed since 14.0 (`ocr-result.ts`,
`quote-locate.ts`, this harness), so the accuracy below is the same record,
re-measured; the times are new.

| kind of page | quotes | located | gate |
|---|---:|---:|---:|
| single-column English | 231 | 229 (99.1%) | ≥ 95% |
| Chinese prose | 90 | 79 (87.8%) | ≥ 85% |
| two-column (reported) | 159 | 124 (78.0%) | — |
| table cells (reported) | 182 | 125 (68.7%) | — |
| **generated corpus** | 662 | **557 (84.1%)** | ≥ 80% |
| fetched, incl. the real Vicksburg scan (reported) | 360 | 236 (65.6%) | — |
| altered quotes wrongly located | 1,997 | 1 (0.05%) | ≤ 1% |

Every gate passes; the tightest is Chinese prose, 2.8 points above its floor.
Time per page from the same run's per-page `ms` (median = the middle page, as
the suite's own median is computed; p90 = nearest rank):

| pages | median | p90 |
|---|---:|---:|
| 200 dpi — English, the fetched documents (41 pages) | 2.49 s | 4.90 s |
| 300 dpi — Chinese (10 pages) | 3.46 s | 4.17 s |
| all 51 pages — the gate's median ≤ 5 s | 2.49 s | 4.89 s |

The times are this machine's and move with its load; the accuracy has not
moved across runs. `PW_OCR_DPI=300 npm run eval` measures every page at
another resolution; that is how Chinese came to be read at 300. A miss on a
scanned page is shown to the reader as *unconfirmed*, never as *not on the
page*.

## Real models

```bash
npm run dev          # the app, in another shell
npm run eval         # once, to extract the corpus
PW_EVAL_BASE_URL=https://api.openai.com/v1 PW_EVAL_API_KEY=… PW_EVAL_MODEL=gpt-4o-mini \
  npm run eval:live -- --docs=contract-zh,paper-en --limit=10
npm run eval         # now also scores eval/out/live/*.jsonl
```

`eval/live/run.mjs` drives the real app in Chromium — the agent is assembled
across too many modules to call directly — with the Tauri shell mocked from
the extractor's output, and forwards the app's model requests to
`PW_EVAL_BASE_URL`. The key is read from the environment, sent only there, and
never written to a recording. With no key it runs a scripted model, so the whole
path can be checked for free. Recordings worth keeping for comparison can be
committed under `eval/baselines/`.

The sentence columns run each recorded answer through the same split and the
same state rule the app's line under an answer uses (`answer-sentences.ts`),
over the corpus pages the recording was made against — so the number the reader
would see is measured, not a copy of it.

## Corpus

`eval/corpus/*.pdf` are generated and committed — see `build.mjs` and
`build_reportlab.py` for what each exercises (two typesetters, CJK, two columns,
running headers, tables, words hyphenated across lines). Sources are either
licences that permit verbatim copies or text written for this corpus.
`eval/corpus/fetched/` holds real documents made by producers nobody here chose;
see `fetch.mjs`.

## Extraction

`eval/extract` is a small Rust binary that includes `src-tauri/src/inspect.rs`
by path, so the evaluation reads PDFs with the code that ships — without Tauri's
system dependencies. Its output is cached in `eval/out/` (ignored by git).
