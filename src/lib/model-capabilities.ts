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
  "qwen/qwen2.5-vl-72b-instruct": cap(true, true),
  "qwen/qwen2.5-vl-7b-instruct": cap(true, true),
  "google/gemini-2.5-flash-lite": cap(true, true),
  "google/gemini-2.5-flash": cap(true, true),
  "anthropic/claude-3.5-sonnet": cap(true, true),

  "llama3.2": cap(false, false),
  "llama3.1": cap(false, false),
  "qwen2.5": cap(false, false),
  mistral: cap(false, false),
  "qwen2.5vl": cap(true, false),
  llava: cap(true, false),
};

export function isVisionModel(provider: ProviderId, model: string): boolean {
  if (provider === "custom") return false;
  return MODEL_CAPABILITIES[model]?.vision ?? false;
}

export function isToolModel(provider: ProviderId, model: string): boolean {
  if (provider === "custom") return true;
  const known = MODEL_CAPABILITIES[model];
  if (known) return known.tools;
  if (provider === "openai" || provider === "deepseek") return true;
  return false;
}

export function modelSupportsVision(provider: ProviderId, model: string): boolean {
  return isVisionModel(provider, model);
}
