export type ProviderId = "openai" | "deepseek" | "openrouter" | "ollama" | "custom";

export interface LlmSettings {
  provider: ProviderId;
  apiKey: string;
  model: string;
  baseURL?: string;
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
  model: "deepseek-chat",
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
    defaultModel: "deepseek-chat",
  },
  openrouter: {
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "deepseek/deepseek-chat",
  },
  ollama: {
    label: "Ollama (local)",
    baseURL: "http://localhost:11434/v1",
    defaultModel: "llama3.2",
  },
};
