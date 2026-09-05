import type { DocAnnotation } from "./pdf-annotations";
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
  /** OpenRouter server-side web search (the `web` plugin). Inert for other providers. */
  webSearch?: boolean;
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
  /** OpenRouter server-side web search (the `web` plugin). Inert for other providers. */
  webSearch?: boolean;
  /** Set true only after a successful test connection. */
  connectionVerified?: boolean;
}

export interface PageText {
  page: number;
  text: string;
  /**
   * Where the text came from. Vision text was paid for per page; native text is
   * free to recompute on every open. Merges must never let the free one win.
   */
  source?: "native" | "vision";
}

/** A rectangle in PDF points. Bottom-left origin, as the Rust side documents. */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocHeading {
  title: string;
  page: number;
  level: number;
}

export interface DocLink {
  page: number;
  url: string;
  /** The line the link sits on, or "" when none could be matched. */
  context: string;
  rect: PdfRect;
}

export interface DocFigure {
  page: number;
  rect: PdfRect;
}

/** Everything one parse of a PDF yields. Mirrors `inspect::DocumentModel`. */
export interface DocumentModel {
  page_count: number;
  title: string | null;
  pages: { page: number; text: string; needs_vision: boolean; has_table: boolean }[];
  outline: DocHeading[];
  /** Headings the document declares itself, when it is a tagged PDF. */
  structure_outline: DocHeading[];
  links: DocLink[];
  figures: DocFigure[];
}

/** A run of text on a page and where it sits. Rect is bottom-left origin. */
export interface TextItemRect {
  text: string;
  rect: PdfRect;
}

export interface RegionText {
  text: string;
  table: string | null;
}

export interface LoadedDocument {
  path: string;
  name: string;
  kind: "pdf" | "image";
  pages: PageText[];
  totalPages: number;
  /**
   * Freshness key (mtime + size) for the file on disk. Keys the persistent page
   * index; empty/absent means the index cache is bypassed for this document.
   */
  stamp?: string;
  /**
   * Content fingerprint — what the file is, as opposed to where it is. The
   * reader's marks, findings and chat are keyed on it beside the path, so a
   * renamed or moved file finds its own record. Empty when unobtainable; see
   * `file-identity.ts`.
   */
  identity?: string;
  /** Title from the PDF's metadata, when it has one. */
  title?: string;
  /**
   * The document's sections — already arbitrated.
   *
   * Bookmarks if it has them, else its tagged headings, else headings recovered
   * from the text. Resolved once at load so the reader's sidebar and the model
   * are never looking at two different lists; see `preferAuthoredOutline`.
   */
  outline?: DocHeading[];
  links?: DocLink[];
  figures?: DocFigure[];
  /** Pages whose text contains a table. */
  tablePages?: number[];
  /**
   * Notes already written on the document by whoever sent it — highlights,
   * sticky notes, questions in the margin. Not the reader's own marks, which
   * live in `mark-store` and use the other coordinate convention.
   */
  annotations?: DocAnnotation[];
  /**
   * What each page calls itself, when that differs from where it sits.
   *
   * Absent for the great majority of documents — see `page-labels.ts`. Present
   * means the reader and the app count differently, and every number crossing
   * between them has to say which kind it is.
   */
  pageLabels?: string[];
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
