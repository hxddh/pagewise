/**
 * When a page read with English alone should be read again with both models,
 * and when the second reading wins (22.0).
 *
 * The models used to follow the interface language only, so a Chinese scan
 * opened under an English interface was read with English alone: 2.2% of its
 * quotes located, against 87.8% with both models (the OCR eval, 2026-10-15),
 * and nothing on screen said why. The page itself says it: English on Chinese
 * print reads garbage at a mean confidence of 17–18, while every English
 * document in the corpus reads above 74. Shared by the app (`ocr-service.ts`)
 * and the evaluation (`eval/ocr.eval.ts`), so the gate measures this rule.
 */

/** A reading with words under this mean confidence is retried with both models. */
export const CJK_RETRY_CONFIDENCE = 50;
/** Both models must beat English by this much to be taken. */
export const CJK_SWITCH_MARGIN = 10;
/** Characters a reading needs before its confidence says anything. */
export const MIN_PROBE_CHARS = 20;

export interface Reading {
  text: string;
  confidence: number;
}

/** Whether an English-only reading looks like a page in another script. */
export function doubtfulInEnglish(reading: Reading): boolean {
  return reading.confidence < CJK_RETRY_CONFIDENCE && reading.text.trim().length >= MIN_PROBE_CHARS;
}

/** Whether the reading with both models is the one to keep. */
export function bothModelsWin(english: Reading, both: Reading | null): boolean {
  return !!both && both.confidence >= english.confidence + CJK_SWITCH_MARGIN;
}
