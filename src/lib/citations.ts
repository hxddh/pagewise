import { getToolName, isToolUIPart, type UIMessage } from "ai";

export interface PageCitation {
  page: number;
  pageEnd?: number;
  excerpt: string;
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
  if (s.length <= max) return s;
  return `${s.slice(0, max).trim()}…`;
}

export function extractCitationsFromMessage(message: UIMessage): PageCitation[] {
  const citations: PageCitation[] = [];

  for (const part of message.parts) {
    if (!isToolUIPart(part) || part.state !== "output-available") continue;

    const name = getToolName(part);
    const input =
      part.input && typeof part.input === "object"
        ? (part.input as Record<string, unknown>)
        : {};
    const excerpt = extractExcerpt(part.output);

    if (!excerpt) continue;

    if (name === "read_pdf_page" && typeof input.page === "number") {
      citations.push({ page: input.page, excerpt });
    } else if (
      name === "read_pdf_range" &&
      typeof input.start === "number" &&
      typeof input.end === "number"
    ) {
      citations.push({
        page: input.start,
        pageEnd: input.end,
        excerpt,
      });
    }
  }

  return citations;
}

export function getLatestAgentActivity(messages: UIMessage[]): string | null {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
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
      return `Reading page ${input.page}…`;
    }
    if (name === "read_pdf_range") {
      return "Reading pages…";
    }
    if (name === "search_in_document") return "Searching document…";
    if (name === "ocr_file") return "Running OCR…";
    return "Working…";
  }

  return null;
}
