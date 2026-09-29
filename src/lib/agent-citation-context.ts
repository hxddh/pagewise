/**
 * Tell the model which of its citations did not check out.
 *
 * The chips under an answer tell the READER which quotes were not found on
 * their pages. Until this, the model was never told — so the next answer could
 * restate the same unfound quote with the same confidence, and the only party
 * who could not see the red chip was the one who wrote it. The same split 12.0
 * closed for the record ("the panel warned the reader and told the model
 * nothing"), closed here for answers.
 *
 * Only the answer immediately before this question is read: that is what the
 * reader is looking at and most likely asking about, and older answers have
 * already had their turn to be corrected. Only citations whose check is
 * already known are named — this runs inside `prepareCall`, which cannot wait
 * on IPC, and a check that has not come back yet is not a failure.
 *
 * Rides on the user message with the rest of the volatile context, never on
 * the system prompt, for the reason `agent-record-context.ts` gives.
 */
import { cachedCitationCheck } from "./citation-check";
import { extractCitations } from "./citations";
import { sanitizeForPrompt } from "./agent-view-context";

/** Most failed citations named in one note. */
export const MAX_FAILED_CITATIONS = 5;

type ModelMessage = { role: string; content: unknown };

/** The text of a model message, whichever shape its content has. */
function textOf(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
}

/** The assistant's answer just before the newest user message, or "". */
export function previousAnswerText(messages: readonly ModelMessage[] | undefined): string {
  if (!messages) return "";
  let i = messages.length - 1;
  while (i >= 0 && messages[i]!.role !== "user") i -= 1;
  const parts: string[] = [];
  for (i -= 1; i >= 0 && messages[i]!.role !== "user"; i -= 1) {
    if (messages[i]!.role === "assistant") parts.unshift(textOf(messages[i]!));
  }
  return parts.join("\n");
}

export function buildCitationFeedback(path: string | null, messages: readonly ModelMessage[] | undefined): string {
  if (!path) return "";
  const answer = previousAnswerText(messages);
  if (!answer) return "";
  const failed: string[] = [];
  const seen = new Set<string>();
  for (const c of extractCitations(answer)) {
    const check = cachedCitationCheck(path, c);
    if (check?.status !== "unlocated" && check?.status !== "outOfRange") continue;
    if (seen.has(c.raw)) continue;
    seen.add(c.raw);
    const pages = c.pages.length > 1 ? `p${c.pages[0]}-${c.pages[c.pages.length - 1]}` : `p${c.pages[0]}`;
    const why = check.status === "outOfRange" ? "that page does not exist" : "these words are not on that page";
    failed.push(`- ${pages} '${sanitizeForPrompt(c.quote ?? "", 160)}' — ${why}`);
    if (failed.length >= MAX_FAILED_CITATIONS) break;
  }
  if (failed.length === 0) return "";
  return (
    `\n\nIn your previous answer, these citations were checked against the document and not found:\n` +
    `${failed.join("\n")}\n` +
    `Do not repeat them as they stand. If one matters to this question, read the page and quote what it ` +
    `actually says; if it was wrong, say so plainly.`
  );
}
