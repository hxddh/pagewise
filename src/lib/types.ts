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

/** Grouped model options for settings UI. */
export const PROVIDER_MODEL_GROUPS: Record<
  Exclude<ProviderId, "custom">,
  { labelKey: string; models: string[] }[]
> = {
  openai: [
    {
      labelKey: "settings.modelGroupFast",
      models: ["gpt-4o-mini", "gpt-4.1-mini"],
    },
    {
      labelKey: "settings.modelGroupPro",
      models: ["gpt-4o", "gpt-4.1"],
    },
  ],
  deepseek: [
    {
      labelKey: "settings.modelGroupFast",
      models: ["deepseek-v4-flash"],
    },
    {
      labelKey: "settings.modelGroupPro",
      models: ["deepseek-v4-pro"],
    },
  ],
  openrouter: [
    {
      labelKey: "settings.modelGroupAgent",
      models: [
        "openai/gpt-4o-mini",
        "anthropic/claude-3.5-sonnet",
        "google/gemini-2.5-flash-lite",
      ],
    },
    {
      labelKey: "settings.modelGroupVision",
      models: [
        "openai/gpt-4o-mini",
        "qwen/qwen2.5-vl-72b-instruct",
        "google/gemini-2.5-flash-lite",
      ],
    },
    {
      labelKey: "settings.modelGroupChatOnly",
      models: ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
    },
  ],
  ollama: [
    {
      labelKey: "settings.modelGroupLocal",
      models: ["llama3.2", "llama3.1", "qwen2.5", "mistral"],
    },
    {
      labelKey: "settings.modelGroupVision",
      models: ["qwen2.5vl", "llava"],
    },
  ],
};

export const LEGACY_MODEL_MAP: Record<string, { model: string; thinkingEnabled: boolean }> = {
  "deepseek-chat": { model: "deepseek-v4-flash", thinkingEnabled: false },
  "deepseek-reasoner": { model: "deepseek-v4-flash", thinkingEnabled: true },
};

export function allProviderModels(provider: Exclude<ProviderId, "custom">): string[] {
  return PROVIDER_MODEL_GROUPS[provider].flatMap((g) => g.models);
}

/** Default agent (tool-capable) model per provider. */
export function defaultAgentModel(provider: Exclude<ProviderId, "custom">): string {
  return PROVIDER_PRESETS[provider].defaultModel;
}

/** Default vision model for background page indexing. */
export function defaultVisionModel(provider: Exclude<ProviderId, "custom">): string {
  if (provider === "openai") return "gpt-4o-mini";
  if (provider === "openrouter") return "openai/gpt-4o-mini";
  if (provider === "ollama") return "qwen2.5vl";
  return "";
}

export function visionModelsForProvider(provider: Exclude<ProviderId, "custom">): string[] {
  const visionGroups = PROVIDER_MODEL_GROUPS[provider].filter((g) =>
    g.labelKey.includes("Vision") || g.labelKey.includes("vision"),
  );
  const fromGroups = visionGroups.flatMap((g) => g.models);
  const agentDefault = defaultAgentModel(provider);
  const merged = new Set(fromGroups);
  if (agentDefault) merged.add(agentDefault);
  return [...merged];
}
