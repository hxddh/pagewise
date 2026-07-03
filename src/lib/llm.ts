import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel } from "ai";
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  type LlmSettings,
  type ProviderId,
} from "./types";

export function resolveModel(settings: LlmSettings = DEFAULT_SETTINGS): LanguageModel {
  const preset =
    settings.provider !== "custom" ? PROVIDER_PRESETS[settings.provider] : undefined;

  const baseURL =
    settings.baseURL ?? preset?.baseURL ?? PROVIDER_PRESETS.openai.baseURL;

  const apiKey =
    settings.apiKey ||
    (settings.provider === "ollama" ? "ollama" : "");

  const modelId = settings.model || preset?.defaultModel || "gpt-4o-mini";

  const client = createOpenAI({ apiKey, baseURL });
  return client(modelId);
}

export async function testConnection(settings: LlmSettings): Promise<string> {
  const { text } = await generateText({
    model: resolveModel(settings),
    prompt: "Reply with exactly: OK",
  });
  return text.trim();
}

export function settingsForProvider(
  provider: ProviderId,
  current: LlmSettings,
): Partial<LlmSettings> {
  if (provider === "custom") {
    return { provider, baseURL: current.baseURL ?? "" };
  }
  const preset = PROVIDER_PRESETS[provider];
  return {
    provider,
    model: preset.defaultModel,
    baseURL: undefined,
  };
}
