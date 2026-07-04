import type { UIMessage } from "ai";
import { streamObject } from "ai";
import { z } from "zod";
import {
  extractAssistantText,
  extractToolExcerpts,
  findLastMessage,
} from "./messages-utils";
import { resolveModel, resolveReasoning } from "./llm";
import { loadSettings } from "./settings";

export const exportSummarySchema = z.object({
  title: z.string(),
  overview: z.string(),
  keyPoints: z.array(z.string()),
});

export type ExportSummaryObject = z.infer<typeof exportSummarySchema>;

export function summaryObjectToMarkdown(
  object: ExportSummaryObject,
  docName?: string,
): string {
  const lines: string[] = [`# ${object.title}`, ""];

  if (docName) {
    lines.push(`**Document:** ${docName}`, "");
  }

  lines.push(`**Generated:** ${new Date().toLocaleString()}`, "", "## Overview", "", object.overview, "");

  if (object.keyPoints.length > 0) {
    lines.push("## Key points", "");
    for (const point of object.keyPoints) {
      lines.push(`- ${point}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim() + "\n";
}

export class ExportSummaryError extends Error {
  constructor(code: "NO_SUMMARY") {
    super(code);
    this.name = "ExportSummaryError";
  }
}

export async function streamExportSummary(
  messages: UIMessage[],
  options?: {
    docName?: string;
    onPartial?: (markdown: string) => void;
    signal?: AbortSignal;
  },
): Promise<string> {
  const lastAssistant = findLastMessage(messages, (m) => m.role === "assistant");
  const source = lastAssistant ? extractAssistantText(lastAssistant) : "";
  const excerpts = lastAssistant ? extractToolExcerpts(lastAssistant) : "";

  if (!source.trim() && !excerpts.trim()) {
    throw new ExportSummaryError("NO_SUMMARY");
  }

  const settings = await loadSettings();
  const { partialObjectStream, object } = streamObject({
    model: resolveModel(settings),
    schema: exportSummarySchema,
    reasoning: resolveReasoning(settings),
    abortSignal: options?.signal,
    prompt: `Turn the assistant answer into a polished export summary with a title, overview paragraph, and key bullet points. Use the same language as the source.

Assistant answer:
${source.slice(0, 8000)}

Supporting excerpts:
${excerpts.slice(0, 4000)}`,
  });

  for await (const partial of partialObjectStream) {
    if (options?.onPartial && partial.title && partial.overview) {
      options.onPartial(
        summaryObjectToMarkdown(
          {
            title: partial.title,
            overview: partial.overview,
            keyPoints: (partial.keyPoints ?? []).filter(
              (point): point is string => typeof point === "string" && point.length > 0,
            ),
          },
          options.docName,
        ),
      );
    }
  }

  const final = await object;
  return summaryObjectToMarkdown(final, options?.docName);
}
