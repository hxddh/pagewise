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
| `search.eval.ts` | Asked in the reader's words rather than the document's, does `search_in_document` put the right page in its first three? Over the 36 `lookup` questions only (24.0). | ≥ 80%, and never worse than exact search on any question |
| `ocr.eval.ts` | Every page rendered to an image and read by the local OCR the app ships (14.0) — are the same quotes found among the recognised words? | English single-column ≥ 95%, Chinese prose ≥ 85%, generated corpus ≥ 80%, altered quotes ≤ 1% wrongly located, median ≤ 5 s a page |
| `annotate.eval.ts` | Located quotes written into the PDF as highlights by the app's export code (14.1), read back with pdf.js — is each there, and is the quote the text under it? | all read back, ≥ 97% with the quote under the highlight (measured 626 of 629) |
| `numbers.eval.ts` | Corpus sentences stating a quantity, cited and read against their passage (15.0): honest and reworded claims must not be flagged; claims with one number changed should be | ≤ 0.5% false alarms (measured 0 of 231), ≥ 85% caught (measured 94.0%) |
| `live-score.eval.ts` | Recorded answers from real models (below): how many cite, how many quotes are on their pages, how many cite a right page — and every sentence through the app's own sentence table (20.0): sentences, marked, verified, unchecked, and how many unchecked sentences' numbers the text they cite states. Per kind of question (24.0): located, right page, facts stated, correct refusals, fabricated citations. | none — it measures models, not this repository |

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
| Chinese prose, English interface (22.0) | 90 | 79 (87.8%) | ≥ 85% |
| two-column (not a promise) | 159 | 124 (78.0%) | — |
| table cells (not a promise) | 182 | 125 (68.7%) | — |
| **generated corpus** | 662 | **557 (84.1%)** | ≥ 80% |
| fetched, incl. the real Vicksburg scan (reported) | 360 | 236 (65.6%) | — |
| altered quotes wrongly located | 1,997 | 1 (0.05%) | ≤ 1% |

Every gate passes; the tightest is Chinese prose, 2.8 points above its floor.

The English-interface row is the app's own rule (`src/lib/ocr/ocr-language.ts`):
read with English first, and a page whose words come back at a mean confidence
under 50 is read again with both models, which are kept when they do at least
10 points better. Until 22.0 the models followed the interface language only,
and this row was **2.2%** — English-only on Chinese print reads at a confidence
of 17–18, every English document here above 74. All 10 Chinese pages are read
again, and 1 of the 41 pages read with English is (page 4 of the fetched
GeoBase scan, which reads poorly in any model) — the rule's cost, reported by
the suite (measured 2026-10-15, on the tree of this change).

**Scanned tables and two-column scans are not a promise** (21.0). About a
third of the table cells on a scan are not found among the recognised words —
recognition reads across cells and columns in an order that does not match the
quote — and no gate holds that number. A citation into a scanned table that is
not found shows as *unconfirmed*, the same state any unmatched quote on a scan
gets; nothing else in the app claims more. Raising this to a gate needs a
region-level recognition path or another engine, measured on this same harness
first (see `docs/reviews/v20-ocr-spike.md`); until then the rows above are a
record, not a commitment.
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
  npm run eval:live -- --docs=contract-zh,paper-en --limit=10 --repeat=3
npm run eval         # now also scores eval/out/live/*.jsonl
# the score tables alone, printed (vitest hides a passing test's console):
npx vitest run --config eval/vitest.config.ts eval/live-score.eval.ts --disableConsoleIntercept
```

| flag | |
|---|---|
| `--docs=a,b` | only these documents |
| `--kinds=list,none` | only these kinds of question (24.0) |
| `--limit=N` | at most N questions, taken round-robin across kinds, so `--limit=6` asks one of each (24.0); 3 by default with no key |
| `--repeat=N` | ask each question N times; every run is a separate line with its `run` number (24.0) |
| `--timeout=ms` | per question, 240 s by default; rate-limit waits (429) count against it |
| `--out=file` | where to write the recording |

### Questions (24.0)

`questions.ts` holds 114 questions in five kinds — the first 36 are the
single lookups the search suite gates on; the rest were added for the live
baseline (review 2026-10-18 §2.4):

| kind | count | what a right answer does | what is recorded with it |
|---|---:|---|---|
| `lookup` | 36 | cites the page carrying `answer` | — |
| `list` | 26 | enumerates several items or reads a table | `answers` (one wording per page), `facts` |
| `crossPage` | 17 | combines facts from two or more pages, citing each | `answers` (one per page), `facts` |
| `none` | 15 | says the document does not contain it, citing nothing as the answer | — |
| `scanned` | 20 | a lookup on the real scan (`vicksburg-ocr`, the only scanned document), whose OCR text has its own misspellings | `answer`, `facts` |

Wordings and facts were read off the extracted page text, never written from
memory; every wording is on some page and every fact is in the document (a
cross-page fact may be a product of two that are — 10% of the contract total).
`facts` match under the same normalisation as wordings, plus thousands
separators; an array is a set of alternatives ("三十六个月" or "36个月").
Each question has a stable id, `<doc>/<kind>-<n>`, so new questions are
appended to their group, never inserted.

### What a recording holds, and how it is scored

Each line: `id`, `kind`, `run`, the question, the wordings and facts it was
asked with, the answer, `steps`, `toolCalls` (the tool names called at each
step), token usage, and the citation chips as the app showed them. The scorer
reads the wordings and facts from the recording itself, so a baseline stays
scoreable after `questions.ts` changes.

The per-kind table (printed per recording file, and written to
`eval/out/live-score.md` / `.json`):

| column | meaning |
|---|---|
| located | quoted citations whose words are on the page they name |
| right page | every wording's page is among the cited pages (one wording for a lookup; all of them for a cross-page answer); not scored on `none` |
| facts | mean share of the question's facts the answer states |
| says no | `none` only: the answer says the document does not contain it (English or Chinese patterns, `SAYS_NOT_FOUND`) |
| refused | `none` only: says no **and** carries no located citation — presenting a passage as the answer to a question the document does not answer is not a refusal, even if the text also says "not found" |
| fabricated | quoted citations whose words are on no page of the document at all (an invented quote, not a wrong page), of quoted citations |
| tools | mean tool calls per answer |

With no key, the scripted model answers each kind the way the scorer needs to
see exercised: a lookup cites once right and once with an invented quote; a
list or cross-page answer cites every wording and states the facts (a
cross-page question searches twice); a `none` answer says "not in the
document". Its numbers check the plumbing, not a model.

### The workflow

`.github/workflows/live-eval.yml` (manual: *Actions → Live eval → Run
workflow*) runs the whole thing on a GitHub runner: extracts the corpus
(Rust, `npm run eval:fetch`, `npm run eval`), installs Playwright's Chromium,
starts the dev server, runs `eval:live` with the `repeat`, `docs` and `limit`
inputs, scores, and uploads the JSONL with `live-score.md` / `.json` as an
artifact (the score table also goes to the run summary).

It uses GitHub Models with the run's own `GITHUB_TOKEN` (`permissions:
models: read`; model `openai/gpt-4o-mini` by default). When a
`PW_EVAL_API_KEY` repository secret exists it is used instead, against the
`PW_EVAL_BASE_URL` secret (OpenAI when unset), with the `model` input passed
through as `PW_EVAL_MODEL` — name the model as that provider does. A baseline
worth keeping is committed under `eval/baselines/`.

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
