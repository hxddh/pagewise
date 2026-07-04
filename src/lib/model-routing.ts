import type { LanguageModel } from "ai";
import { resolveModel } from "./llm";
import type { LlmSettings } from "./types";

const FAST_MODEL_CANDIDATES: Record<string, string> = {
  "gpt-4o": "gpt-4o-mini",
  "gpt-4.1": "gpt-4.1-mini",
  "gpt-5": "gpt-4o-mini",
  "deepseek-v4-pro": "deepseek-v4-flash",
  "deepseek-reasoner": "deepseek-v4-flash",
  "claude-3-5-sonnet": "claude-3-5-haiku",
  "claude-sonnet-4": "claude-3-5-haiku",
};

/** Pick a cheaper model for intermediate tool-only steps. */
export function pickFastModelId(settings: LlmSettings): string | null {
  const current = settings.model.trim();
  if (!current) return null;

  const direct = FAST_MODEL_CANDIDATES[current];
  if (direct && direct !== current) return direct;

  for (const [prefix, fast] of Object.entries(FAST_MODEL_CANDIDATES)) {
    if (current.startsWith(prefix) && fast !== current) return fast;
  }

  if (/mini|flash|haiku|small/i.test(current)) return null;
  if (settings.provider === "openai") return "gpt-4o-mini";
  if (settings.provider === "deepseek") return "deepseek-v4-flash";
  if (settings.provider === "openrouter" && !current.includes("mini")) {
    return "openai/gpt-4o-mini";
  }
  return null;
}

export function resolveFastModel(settings: LlmSettings): LanguageModel | null {
  const fastId = pickFastModelId(settings);
  if (!fastId || fastId === settings.model) return null;
  return resolveModel({ ...settings, model: fastId });
}

export function shouldUseFastModelForStep(
  stepNumber: number,
  steps: Array<{ toolCalls?: unknown[]; text?: string }>,
): boolean {
  if (stepNumber === 0) return false;
  const last = steps[steps.length - 1];
  if (!last) return false;
  const hadTools = (last.toolCalls?.length ?? 0) > 0;
  const hasText = !!last.text?.trim();
  return hadTools && !hasText;
}
