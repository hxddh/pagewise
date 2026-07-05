import { embed, embedMany } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { resolveBaseURL } from "./llm";
import { isEmbeddingCapableProvider } from "./model-capabilities";
import type { LlmSettings } from "./types";

const DEFAULT_EMBED_MODEL = "text-embedding-3-small";
const OLLAMA_EMBED_MODEL = "nomic-embed-text";

/** Max texts per `embedMany` call — keeps request bodies within provider limits. */
export const EMBED_BATCH_SIZE = 64;

/** Cap on pages embedded per document (mirrors vision-index's DEFAULT_MAX_INDEX_PAGES). */
export const DEFAULT_MAX_INDEX_PAGES = 50;

/** One short retry on a rate-limit (429) before nulling a batch. */
const MAX_EMBED_RETRIES = 1;
const RETRY_DELAY_MS = 250;

interface EmbedTextsOptions {
  /** Abort in-flight batching (e.g. when the active document switches). */
  signal?: AbortSignal;
  /** Override the per-document page cap. Defaults to {@link DEFAULT_MAX_INDEX_PAGES}. */
  maxPages?: number;
}

export interface EmbedTextsResult {
  embeddings: Array<number[] | null>;
  /** True when eligible pages exceeded {@link DEFAULT_MAX_INDEX_PAGES}. */
  capped: boolean;
  eligible: number;
  embedded: number;
}

function warn(message: string, error?: unknown): void {
  if (import.meta.env.DEV) {
    if (error !== undefined) console.warn(message, error);
    else console.warn(message);
  }
}

function embedModelId(settings: LlmSettings): string {
  return settings.provider === "ollama" ? OLLAMA_EMBED_MODEL : DEFAULT_EMBED_MODEL;
}

/**
 * Stable key identifying the embedding model backing an index. Used to detect
 * provider/model drift so a stale index (different model → different vector space
 * or dimensionality) is rebuilt instead of silently scoring 0.
 */
export function embeddingModelKey(settings: LlmSettings): string {
  return `${settings.provider}:${embedModelId(settings)}`;
}

function resolveEmbedModel(settings: LlmSettings) {
  const baseURL = resolveBaseURL(settings);
  const apiKey = settings.apiKey || (settings.provider === "ollama" ? "ollama" : "");
  const client = createOpenAI({ apiKey, baseURL });
  return client.embedding(embedModelId(settings));
}

function isRateLimit(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("429") || msg.toLowerCase().includes("rate limit");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        resolve();
      },
      { once: true },
    );
  });
}

export async function embedText(
  settings: LlmSettings,
  value: string,
): Promise<number[] | null> {
  // Gate on provider capability: attempting an embedding against a provider with no
  // embeddings endpoint just 404s. Skip entirely so retrieval stays keyword-only.
  if (!isEmbeddingCapableProvider(settings.provider)) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const { embedding } = await embed({
      model: resolveEmbedModel(settings),
      value: trimmed.slice(0, 8000),
    });
    return embedding;
  } catch (error) {
    warn(`[embeddings] embedText failed for provider "${settings.provider}"`, error);
    return null;
  }
}

type EmbedModel = ReturnType<typeof resolveEmbedModel>;

/** Embed one batch, retrying once on a rate-limit. Returns null on failure. */
async function embedBatch(
  model: EmbedModel,
  values: string[],
  provider: string,
  signal?: AbortSignal,
): Promise<number[][] | null> {
  for (let attempt = 0; attempt <= MAX_EMBED_RETRIES; attempt++) {
    if (signal?.aborted) return null;
    try {
      const { embeddings } = await embedMany({ model, values });
      return embeddings;
    } catch (error) {
      if (attempt < MAX_EMBED_RETRIES && isRateLimit(error)) {
        warn(`[embeddings] batch rate-limited; retrying after ${RETRY_DELAY_MS}ms`, error);
        await delay(RETRY_DELAY_MS, signal);
        continue;
      }
      warn(`[embeddings] batch embedding failed for provider "${provider}"`, error);
      return null;
    }
  }
  return null;
}

/**
 * Embed many texts, returning an index-aligned array the SAME LENGTH as `values`.
 * Failed / skipped slots are `null` so callers can align vectors to their source pages.
 *
 * Behaviour:
 * - Providers without a known embeddings endpoint are skipped (all-null).
 * - Blank texts get no embedding (null slot).
 * - Only the first `maxPages` non-blank texts are embedded (cost/limit guard).
 * - Texts are chunked into {@link EMBED_BATCH_SIZE} batches; a failed batch nulls
 *   only its own slots — successful batches are kept.
 * - An {@link AbortSignal} is honoured between batches.
 */
export async function embedTexts(
  settings: LlmSettings,
  values: string[],
  options: EmbedTextsOptions = {},
): Promise<EmbedTextsResult> {
  const result: Array<number[] | null> = new Array(values.length).fill(null);

  if (!isEmbeddingCapableProvider(settings.provider)) {
    warn(
      `[embeddings] provider "${settings.provider}" has no known embeddings endpoint; skipping semantic embedding (keyword-only search).`,
    );
    return { embeddings: result, capped: false, eligible: 0, embedded: 0 };
  }

  const prepared = values.map((v) => v.trim().slice(0, 8000));

  // Index-aligned list of non-blank slots that are worth embedding.
  const embeddable: number[] = [];
  for (let i = 0; i < prepared.length; i++) {
    if (prepared[i]) embeddable.push(i);
  }
  if (embeddable.length === 0) {
    return { embeddings: result, capped: false, eligible: 0, embedded: 0 };
  }

  const maxPages = Math.max(0, options.maxPages ?? DEFAULT_MAX_INDEX_PAGES);
  let targets = embeddable;
  let capped = false;
  if (embeddable.length > maxPages) {
    targets = embeddable.slice(0, maxPages);
    capped = true;
    warn(
      `[embeddings] page cap reached: embedding ${targets.length} of ${embeddable.length} pages; remaining skipped this build.`,
    );
  }

  const model = resolveEmbedModel(settings);

  for (let start = 0; start < targets.length; start += EMBED_BATCH_SIZE) {
    if (options.signal?.aborted) break;
    const batchIdx = targets.slice(start, start + EMBED_BATCH_SIZE);
    const batchValues = batchIdx.map((i) => prepared[i]!);
    const vectors = await embedBatch(model, batchValues, settings.provider, options.signal);
    if (!vectors) continue; // isolate failure: leave this batch's slots null
    for (let j = 0; j < batchIdx.length; j++) {
      const vec = vectors[j];
      if (vec && vec.length > 0) result[batchIdx[j]!] = vec;
    }
  }

  return { embeddings: result, capped, eligible: embeddable.length, embedded: targets.length };
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
