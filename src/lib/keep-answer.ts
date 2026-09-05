import { MAX_CLAIM_TEXT } from "./finding-store";

/**
 * Turn an answer into a claim the record can hold.
 *
 * A finding's claim is capped at 500 characters and an answer is often longer,
 * so something has to give. Cutting at the cap would leave a sentence severed
 * mid-word, which reads as corruption rather than as a summary — and this entry
 * is meant to be read later by someone deciding whether to trust it.
 *
 * So: whole sentences while they fit, and if even the first sentence does not,
 * whole words. Either way a cut ends in an ellipsis — the sentence branch did
 * not until 12.0, so a summary that dropped the answer's last, qualifying
 * sentence read as though that sentence had never been written. Since 12.0 the
 * whole answer is kept beside the claim as `body`, so the claim is a summary of
 * something the record still has, not a replacement for it.
 */
export function claimFromAnswer(text: string, max = MAX_CLAIM_TEXT): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;

  // Sentence boundaries, including the CJK full stop — this app ships in two
  // languages and "." alone would never split a Chinese answer.
  // The trailing alternative is the REST of the string, not the last token. As
  // `\S+$` it matched only the final word, so an answer with no sentence
  // punctuation at all — which is most of a bullet list — came back as that one
  // word. Its own test caught it.
  const sentences = clean.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g) ?? [];
  let out = "";
  for (const sentence of sentences) {
    if ((out + sentence).length > max) break;
    out += sentence;
  }
  out = out.trim();
  // Whole sentences fit, and at least one did not. Say so: the reader deciding
  // whether to trust this entry later has to know it is not the whole answer.
  if (out) return out.length + 1 <= max ? `${out}…` : `${out.slice(0, max - 1).trimEnd()}…`;

  // Not even one sentence fits. Whole words, and say that it was cut.
  const room = max - 1;
  const words = clean.slice(0, room);
  const lastSpace = words.lastIndexOf(" ");
  return `${(lastSpace > room * 0.6 ? words.slice(0, lastSpace) : words).trimEnd()}…`;
}
