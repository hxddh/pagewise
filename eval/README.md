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

No model is called. The quotes are cut from exactly the text the model is given,
so a miss is one the model could not have avoided by copying more carefully.

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
