export type ProviderId = "openai" | "deepseek" | "openrouter" | "ollama" | "custom";

export const ALL_PROVIDER_IDS: ProviderId[] = [
  "openai",
  "deepseek",
  "openrouter",
  "ollama",
  "custom",
];

/** Per-provider config persisted in settings.json (apiKey lives in keychain). */
export interface ProviderProfile {
  /** Agent model — must support tool calling. */
  model: string;
  /** Vision model for PDF/image indexing (may differ from agent model). */
  visionModel?: string;
  baseURL?: string;
  thinkingEnabled?: boolean;
  connectionVerified?: boolean;
}

export interface LlmStoreV2 {
  version: 2;
  activeProvider: ProviderId;
  profiles: Partial<Record<ProviderId, ProviderProfile>>;
}

export type PreviewQuality = "auto" | "crisp" | "performance";

export interface LlmSettings {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseURL?: string;
  thinkingEnabled?: boolean;
  /** Set true only after a successful test connection. */
  connectionVerified?: boolean;
}

export interface PageText {
  page: number;
  text: string;
}

export interface PdfExtractResult {
  pages: PageText[];
  total_pages: number;
}

export interface LoadedDocument {
  path: string;
  name: string;
  kind: "pdf" | "image";
  pages: PageText[];
  totalPages: number;
}

export const DEFAULT_SETTINGS: LlmSettings = {
  provider: "deepseek",
  apiKey: "",
  model: "deepseek-v4-flash",
  thinkingEnabled: false,
  connectionVerified: false,
};

export const PROVIDER_PRESETS: Record<
  Exclude<ProviderId, "custom">,
  { label: string; baseURL: string; defaultModel: string }
> = {
  openai: {
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
  },
  deepseek: {
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
  },
  openrouter: {
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
  },
  ollama: {
    label: "Ollama (local)",
    baseURL: "http://localhost:11434/v1",
    defaultModel: "llama3.2",
  },
};

/** Flat preset lists for the assistant (tool) model dropdown. */
export const PROVIDER_AGENT_MODELS: Record<Exclude<ProviderId, "custom">, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4.1-mini"],
  deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"],
  openrouter: ["openai/gpt-4o-mini", "google/gemini-2.5-flash-lite"],
  ollama: ["llama3.2", "qwen2.5"],
};

/** Flat preset lists for scan/OCR (vision) model dropdown; empty = no presets. */
export const PROVIDER_VISION_MODELS: Record<Exclude<ProviderId, "custom">, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4.1-mini"],
  deepseek: [],
  openrouter: [
    "google/gemini-2.5-flash-lite",
    "qwen/qwen3-vl-8b-instruct",
    "google/gemma-3-4b-it",
  ],
  ollama: ["qwen2.5vl"],
};

export const LEGACY_MODEL_MAP: Record<string, { model: string; thinkingEnabled: boolean }> = {
  "deepseek-chat": { model: "deepseek-v4-flash", thinkingEnabled: false },
  "deepseek-reasoner": { model: "deepseek-v4-flash", thinkingEnabled: true },
};

export function agentPresetModels(provider: Exclude<ProviderId, "custom">): string[] {
  return PROVIDER_AGENT_MODELS[provider];
}

/** @deprecated Use agentPresetModels */
export function allProviderModels(provider: Exclude<ProviderId, "custom">): string[] {
  return agentPresetModels(provider);
}

/** Default agent (tool-capable) model per provider. */
export function defaultAgentModel(provider: Exclude<ProviderId, "custom">): string {
  return PROVIDER_PRESETS[provider].defaultModel;
}

/** Default vision model for background page indexing. */
export function defaultVisionModel(provider: Exclude<ProviderId, "custom">): string {
  const presets = PROVIDER_VISION_MODELS[provider];
  if (presets.length > 0) return presets[0]!;
  if (provider === "openai") return "gpt-4o-mini";
  return "";
}

export function visionPresetModels(provider: Exclude<ProviderId, "custom">): string[] {
  return PROVIDER_VISION_MODELS[provider];
}

/** @deprecated Use visionPresetModels */
export function visionModelsForProvider(provider: Exclude<ProviderId, "custom">): string[] {
  return visionPresetModels(provider);
}
