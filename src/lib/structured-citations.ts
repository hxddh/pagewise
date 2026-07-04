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

export async function extractStructuredCitations(
  answerText: string,
  toolExcerpts: string,
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
    return object.citations;
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
