import { embed, embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { resolveBaseURL } from "./llm";
import type { LlmSettings } from "./types";

const DEFAULT_EMBED_MODEL = "text-embedding-3-small";

function resolveEmbedModel(settings: LlmSettings) {
  const baseURL = resolveBaseURL(settings);
  const apiKey = settings.apiKey || (settings.provider === "ollama" ? "ollama" : "");
  const client = createOpenAI({ apiKey, baseURL });
  const modelId =
    settings.provider === "ollama" ? "nomic-embed-text" : DEFAULT_EMBED_MODEL;
  return client.embedding(modelId);
}

export async function embedText(
  settings: LlmSettings,
  value: string,
): Promise<number[] | null> {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const { embedding } = await embed({
      model: resolveEmbedModel(settings),
      value: trimmed.slice(0, 8000),
    });
    return embedding;
  } catch {
    return null;
  }
}

export async function embedTexts(
  settings: LlmSettings,
  values: string[],
): Promise<Array<number[] | null>> {
  const filtered = values.map((v) => v.trim().slice(0, 8000)).filter(Boolean);
  if (filtered.length === 0) return [];
  try {
    const { embeddings } = await embedMany({
      model: resolveEmbedModel(settings),
      values: filtered,
    });
    return embeddings;
  } catch {
    return filtered.map(() => null);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
