import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, resolveReasoning } from "./llm";
import { loadSettings } from "./settings";

export const structuredCitationSchema = z.object({
  citations: z.array(
    z.object({
      page: z.number().int().min(1),
      pageEnd: z.number().int().min(1).optional(),
      quote: z.string().min(1),
    }),
  ),
});

export type StructuredCitation = z.infer<typeof structuredCitationSchema>["citations"][number];

const extractionSchema = structuredCitationSchema;

/**
 * Normalize extracted citations: drop invalid pages, fix inverted ranges, bound to
 * `[1, totalPages]` when a page count is provided, and dedupe by `page:pageEnd`.
 *
 * `totalPages` is optional and backward compatible: when omitted (or invalid) the only
 * lower bound enforced is `page >= 1` with no upper bound.
 */
export function normalizeStructuredCitations(
  citations: StructuredCitation[],
  totalPages?: number,
): StructuredCitation[] {
  const hasUpperBound =
    typeof totalPages === "number" && Number.isFinite(totalPages) && totalPages >= 1;
  const upper = hasUpperBound ? Math.floor(totalPages) : Number.POSITIVE_INFINITY;

  const seen = new Set<string>();
  const out: StructuredCitation[] = [];
  for (const c of citations) {
    let start = c.page;
    let end = c.pageEnd ?? c.page;
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    // Normalize inverted ranges (start = min, end = max).
    if (end < start) [start, end] = [end, start];
    // Bound to [1, totalPages]; drop citations that fall outside.
    if (start < 1 || end < 1 || start > upper || end > upper) continue;

    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const next: StructuredCitation = { page: start, quote: c.quote };
    if (end !== start) next.pageEnd = end;
    out.push(next);
  }
  return out;
}

export async function extractStructuredCitations(
  answerText: string,
  toolExcerpts: string,
  totalPages?: number,
): Promise<StructuredCitation[]> {
  const answer = answerText.trim();
  if (!answer) return [];

  const settings = await loadSettings();
  try {
    const { object } = await generateObject({
      model: resolveModel(settings),
      reasoning: resolveReasoning(settings),
      schema: extractionSchema,
      prompt: `Extract page citations from the assistant answer. Use only pages evidenced in the tool excerpts.
Return an empty citations array if none are justified.

Assistant answer:
${answer.slice(0, 6000)}

Tool excerpts:
${toolExcerpts.slice(0, 8000)}`,
    });
    return normalizeStructuredCitations(object.citations, totalPages);
  } catch {
    return [];
  }
}

export function formatStructuredCitationsForDisplay(
  citations: StructuredCitation[],
): string {
  return citations
    .map((c) => {
      const range =
        c.pageEnd && c.pageEnd !== c.page ? `${c.page}–${c.pageEnd}` : String(c.page);
      return `[p.${range}] ${c.quote}`;
    })
    .join("\n");
}
