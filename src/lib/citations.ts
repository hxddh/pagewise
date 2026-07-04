import { getToolName, isToolUIPart, type UIMessage } from "ai";
import {
  getInFlightAssistantMessage,
  getLastMessage,
  isAwaitingAssistantReply,
} from "./messages-utils";

export interface PageCitation {
  page: number;
  pageEnd?: number;
  excerpt: string;
}

/**
 * Matches the placeholder text that `pruneToolOutputsForHistory` /
 * `sanitizeDanglingToolParts` substitute for real tool output, so we never
 * render an "omitted from chat history" / "[cancelled]" string as a citation.
 */
const PLACEHOLDER_RE = /^\[Read .*omitted from chat history\]$/;

function isPrunedPlaceholder(output: unknown): boolean {
  if (typeof output !== "string") return false;
  const trimmed = output.trim();
  return trimmed === "[cancelled]" || PLACEHOLDER_RE.test(trimmed);
}

export function extractExcerpt(output: unknown, max = 160): string {
  if (!output) return "";
  if (typeof output === "string") return truncate(output.trim(), max);
  if (typeof output === "object" && output !== null && "text" in output) {
    const text = String((output as { text: unknown }).text).trim();
    return truncate(text, max);
  }
  return truncate(JSON.stringify(output), max);
}

function truncate(s: string, max: number): string {
  // Slice by code points so a surrogate pair (e.g. an emoji) is never split
  // into a lone half that renders as the replacement character.
  const chars = [...s];
  if (chars.length <= max) return s;
  return `${chars.slice(0, max).join("").trim()}…`;
}

/**
 * @param totalPages when provided, citations pointing past the document (or
 *   below page 1) are dropped so a hallucinated `page: 9999` never renders.
 */
export function extractCitationsFromMessage(
  message: UIMessage,
  totalPages?: number,
): PageCitation[] {
  const citations: PageCitation[] = [];
  const seen = new Set<string>();

  const inRange = (page: number): boolean => {
    if (page < 1) return false;
    if (typeof totalPages === "number" && totalPages > 0 && page > totalPages) {
      return false;
    }
    return true;
  };

  const push = (citation: PageCitation): void => {
    const dedupeKey = `${citation.page}:${citation.pageEnd ?? ""}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    citations.push(citation);
  };

  for (const part of message.parts) {
    if (!isToolUIPart(part) || part.state !== "output-available") continue;

    // Pruned/cancelled outputs no longer carry real page text.
    if (isPrunedPlaceholder(part.output)) continue;

    const name = getToolName(part);
    const input =
      part.input && typeof part.input === "object"
        ? (part.input as Record<string, unknown>)
        : {};
    const excerpt = extractExcerpt(part.output);

    if (!excerpt) continue;

    if (name === "read_pdf_page" && typeof input.page === "number") {
      if (!inRange(input.page)) continue;
      push({ page: input.page, excerpt });
    } else if (
      name === "read_pdf_range" &&
      typeof input.start === "number" &&
      typeof input.end === "number"
    ) {
      const start = Math.min(input.start, input.end);
      const end = Math.max(input.start, input.end);
      if (!inRange(start)) continue;
      push({ page: start, pageEnd: end, excerpt });
    }
  }

  return citations;
}

export function getLatestAgentActivity(
  messages: UIMessage[],
  t?: (key: string, vars?: Record<string, string | number>) => string,
  busy = false,
): string | null {
  const lastAssistant = busy
    ? getInFlightAssistantMessage(messages, true)
    : (() => {
        const last = getLastMessage(messages);
        return last?.role === "assistant" ? last : undefined;
      })();
  if (!lastAssistant) return null;

  for (let i = lastAssistant.parts.length - 1; i >= 0; i--) {
    const part = lastAssistant.parts[i];
    if (!isToolUIPart(part)) continue;
    if (part.state !== "input-streaming" && part.state !== "input-available") continue;

    const name = getToolName(part);
    const input =
      part.input && typeof part.input === "object"
        ? (part.input as Record<string, unknown>)
        : {};

    if (name === "read_pdf_page" && typeof input.page === "number") {
      return t
        ? t("agent.activityReadPage", { page: input.page })
        : `Reading page ${input.page}…`;
    }
    if (name === "read_pdf_range") {
      return t ? t("agent.activityReadRange") : "Reading pages…";
    }
    if (name === "get_document_index") {
      return t ? t("agent.activityIndex") : "Scanning document…";
    }
    if (name === "search_in_document") {
      return t ? t("agent.activitySearch") : "Searching document…";
    }
    if (name === "list_documents") return t ? t("agent.activityList") : "Checking documents…";
    return t ? t("agent.activityWorking") : "Working…";
  }

  return null;
}

/** Activity line while the agent is busy (includes gaps between tool steps). */
export function getAgentActivity(
  messages: UIMessage[],
  busy: boolean,
  t?: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  if (!busy) return null;

  const inFlight = getLatestAgentActivity(messages, t, busy);
  if (inFlight) return inFlight;

  if (isAwaitingAssistantReply(messages, busy)) {
    return t ? t("agent.thinking") : "Thinking…";
  }

  const lastAssistant = getInFlightAssistantMessage(messages, busy);
  if (!lastAssistant) return t ? t("agent.thinking") : "Thinking…";

  const textLen = lastAssistant.parts.reduce((sum, p) => {
    if (p.type === "text" && p.text) return sum + p.text.length;
    return sum;
  }, 0);

  if (textLen > 0) {
    return t ? t("agent.activityWriting") : "Writing answer…";
  }

  const hasReasoning = lastAssistant.parts.some(
    (p) => p.type === "reasoning" && !!p.text?.trim(),
  );
  if (hasReasoning) {
    return t ? t("agent.activityThinking") : "Thinking…";
  }

  const hasTools = lastAssistant.parts.some((p) => isToolUIPart(p));
  const allToolsDone =
    hasTools &&
    lastAssistant.parts
      .filter((p) => isToolUIPart(p))
      .every((p) => p.state === "output-available" || p.state === "output-error");

  if (allToolsDone) {
    return t ? t("agent.generatingAnswer") : "Generating answer…";
  }

  if (hasTools) {
    return t ? t("agent.activityFollowUp") : "Continuing analysis…";
  }

  return t ? t("agent.thinking") : "Thinking…";
}
