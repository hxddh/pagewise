import type { ProviderId } from "./types";

export interface ModelCapabilities {
  vision: boolean;
  /** Supports OpenAI-style tool / function calling (required for PageWise agent). */
  tools: boolean;
}

function cap(vision: boolean, tools: boolean): ModelCapabilities {
  return { vision, tools };
}

/** Preset model capabilities (custom models: vision=false, tools=assumed true). */
export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  "gpt-4o-mini": cap(true, true),
  "gpt-4o": cap(true, true),
  "gpt-4.1-mini": cap(true, true),
  "gpt-4.1": cap(true, true),

  "deepseek-v4-flash": cap(false, true),
  "deepseek-v4-pro": cap(false, true),
  /** OpenRouter routes for DeepSeek V4 often lack tool-use endpoints. */
  "deepseek/deepseek-v4-flash": cap(false, false),
  "deepseek/deepseek-v4-pro": cap(false, false),

  "openai/gpt-4o-mini": cap(true, true),
  "openai/gpt-4o": cap(true, true),
  /** OpenRouter VL routes support vision but not reliable tool calling. */
  "qwen/qwen2.5-vl-72b-instruct": cap(true, false),
  "qwen/qwen2.5-vl-7b-instruct": cap(true, false),
  "google/gemini-2.5-flash-lite": cap(true, true),
  "google/gemini-2.5-flash": cap(true, true),
  "google/gemma-3-4b-it": cap(true, false),
  "google/gemma-4-31b-it": cap(true, false),
  "qwen/qwen3-vl-8b-instruct": cap(true, false),
  "anthropic/claude-3.5-sonnet": cap(true, true),

  // Tool-capable Ollama families (modern Ollama exposes OpenAI-style tool calling).
  "llama3.1": cap(false, true),
  "llama3.2": cap(false, true),
  "llama3.3": cap(false, true),
  "qwen2.5": cap(false, true),
  "qwen3": cap(false, true),
  mistral: cap(false, true),
  mixtral: cap(false, true),
  // Vision-first local families (no reliable tool calling).
  "llama3.2-vision": cap(true, false),
  "qwen2.5vl": cap(true, false),
  llava: cap(true, false),
  bakllava: cap(true, false),
  "minicpm-v": cap(true, false),
};

/** Strip an Ollama/OpenRouter tag suffix (":latest", ":7b", ":free") and lowercase. */
function normalizeModelId(model: string): string {
  const colon = model.indexOf(":");
  return (colon >= 0 ? model.slice(0, colon) : model).trim().toLowerCase();
}

/**
 * Resolve capabilities for a model id, tolerating tag suffixes and family variants.
 * Tries an exact match, then a tag-stripped match, then the longest known family whose
 * name prefixes the id (e.g. "qwen2.5-coder" -> "qwen2.5"). Returns undefined if unknown.
 */
function lookupCapabilities(model: string): ModelCapabilities | undefined {
  if (MODEL_CAPABILITIES[model]) return MODEL_CAPABILITIES[model];

  const normalized = normalizeModelId(model);
  if (MODEL_CAPABILITIES[normalized]) return MODEL_CAPABILITIES[normalized];

  let best: ModelCapabilities | undefined;
  let bestLen = -1;
  for (const key of Object.keys(MODEL_CAPABILITIES)) {
    if (normalized === key || normalized.startsWith(`${key}-`)) {
      if (key.length > bestLen) {
        best = MODEL_CAPABILITIES[key];
        bestLen = key.length;
      }
    }
  }
  return best;
}

export function isVisionModel(provider: ProviderId, model: string): boolean {
  const known = lookupCapabilities(model);
  if (known) return known.vision;
  // Custom endpoints may front a vision-capable model we don't know about — allow the attempt.
  if (provider === "custom") return true;
  return false;
}

export function isToolModel(_provider: ProviderId, model: string): boolean {
  const known = lookupCapabilities(model);
  if (known) return known.tools;
  // Unknown model id (custom base URL, a newer OpenRouter/Ollama release): be optimistic.
  // Let the request be attempted and fail server-side (mapped by formatLlmError) rather
  // than hard-blocking a legitimate tool-capable model on the client.
  return true;
}

export function modelSupportsVision(provider: ProviderId, model: string): boolean {
  return isVisionModel(provider, model);
}

/** Providers known to expose an OpenAI-style `/embeddings` endpoint. */
const EMBEDDING_CAPABLE_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "openai",
  "ollama",
]);

/**
 * Whether a provider has a known embeddings endpoint we can POST to.
 *
 * PageWise embeds against the active chat provider's baseURL/key. Only OpenAI and
 * Ollama reliably expose an embeddings route; DeepSeek, OpenRouter and custom
 * endpoints generally do not, so attempting an embedding there just 404s. Callers
 * use this to SKIP embedding (and fall back to keyword-only retrieval) instead of
 * attempting-and-swallowing.
 */
export function isEmbeddingCapableProvider(provider: ProviderId): boolean {
  return EMBEDDING_CAPABLE_PROVIDERS.has(provider);
}

/** Whether the assistant model can accept AI SDK `reasoning` (thinking mode). */
export function isThinkingCapableModel(provider: ProviderId, model: string): boolean {
  if (provider === "custom" || provider === "ollama" || provider === "openai") return false;
  if (provider === "deepseek") return true;
  const m = model.toLowerCase();
  return m.startsWith("deepseek/") || m.includes("reasoner") || m.includes("/r1");
}
