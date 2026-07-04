import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel } from "ai";
import { isToolModel } from "./model-capabilities";
import {
  allProviderModels,
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  type LlmSettings,
  type ProviderId,
} from "./types";

function providerFetch(settings: LlmSettings): typeof fetch | undefined {
  const isOpenRouter = settings.provider === "openrouter";
  const isDeepseekThinking =
    (settings.provider === "deepseek" || settings.provider === "openrouter") &&
    settings.thinkingEnabled;

  if (!isOpenRouter && !isDeepseekThinking) return undefined;

  return async (input, init) => {
    const headers = new Headers(init?.headers);

    if (isOpenRouter) {
      headers.set("HTTP-Referer", "https://pagewise.app");
      headers.set("X-Title", "PageWise");
    }

    let nextInit = { ...init, headers };

    if (isDeepseekThinking && nextInit.body && typeof nextInit.body === "string") {
      try {
        const body = JSON.parse(nextInit.body) as Record<string, unknown>;
        body.thinking = { type: "enabled" };
        if (settings.model.includes("v4-pro")) {
          body.reasoning_effort = "high";
        }
        nextInit = { ...nextInit, body: JSON.stringify(body) };
      } catch {
        /* keep original body */
      }
    }

    return fetch(input, nextInit);
  };
}

/** Chat Completions base URL (no trailing slash). DeepSeek uses /chat/completions, not /v1. */
export function resolveBaseURL(settings: LlmSettings): string {
  const preset =
    settings.provider !== "custom" ? PROVIDER_PRESETS[settings.provider] : undefined;

  let baseURL =
    settings.baseURL?.trim() || preset?.baseURL || PROVIDER_PRESETS.openai.baseURL;

  baseURL = baseURL.replace(/\/+$/, "");

  if (baseURL.includes("api.deepseek.com") && baseURL.endsWith("/v1")) {
    baseURL = baseURL.slice(0, -3);
  }

  return baseURL;
}

function assertApiKey(settings: LlmSettings, t?: TranslateFn): void {
  if (settings.provider === "ollama") return;
  if (!settings.apiKey.trim()) {
    throw new Error(t?.("llm.apiKeyRequired") ?? "API key is required");
  }
}

/**
 * All PageWise providers speak the OpenAI Chat Completions API.
 * createOpenAI()(id) targets the Responses API (/responses) — wrong for DeepSeek etc.
 */
export function resolveModel(settings: LlmSettings = DEFAULT_SETTINGS): LanguageModel {
  const preset =
    settings.provider !== "custom" ? PROVIDER_PRESETS[settings.provider] : undefined;

  const baseURL = resolveBaseURL(settings);

  const apiKey =
    settings.apiKey || (settings.provider === "ollama" ? "ollama" : "");

  const modelId = settings.model || preset?.defaultModel || "gpt-4o-mini";

  const client = createOpenAI({
    apiKey,
    baseURL,
    fetch: providerFetch(settings),
  });

  return client.chat(modelId);
}

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

export function validateModel(
  settings: LlmSettings,
  t?: TranslateFn,
): string | null {
  if (settings.provider === "custom") {
    if (!settings.model.trim()) {
      return t?.("llm.modelRequired") ?? "Model ID is required";
    }
    if (!resolveBaseURL(settings).trim()) {
      return t?.("llm.baseUrlRequired") ?? "Base URL is required";
    }
    return null;
  }
  const known = allProviderModels(settings.provider);
  if (!known.includes(settings.model)) {
    return (
      t?.("llm.unknownModel", { model: settings.model, provider: settings.provider }) ??
      `Unknown model "${settings.model}" for ${settings.provider}`
    );
  }
  return null;
}

export function validateAgentModel(
  settings: LlmSettings,
  t?: TranslateFn,
): string | null {
  const modelError = validateModel(settings, t);
  if (modelError) return modelError;
  if (!isToolModel(settings.provider, settings.model)) {
    return (
      t?.("llm.toolsNotSupported", { model: settings.model }) ??
      `Model "${settings.model}" does not support tool calling required by the agent. Try openai/gpt-4o-mini on OpenRouter, or use the DeepSeek provider directly.`
    );
  }
  return null;
}

export function formatLlmError(error: unknown, t?: TranslateFn): string {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg === "An error occurred.") {
      const cause = (error as Error & { cause?: unknown }).cause;
      if (cause) return formatLlmError(cause, t);
    }
    if (msg.includes("/responses")) {
      return (
        t?.("llm.misconfiguredEndpoint") ??
        "Provider misconfiguration: expected Chat Completions endpoint."
      );
    }
    if (msg.includes("401") || msg.toLowerCase().includes("authentication")) {
      return (
        t?.("llm.invalidApiKey") ?? "Invalid API key — check Settings → AI Provider."
      );
    }
    if (msg.includes("404")) {
      return (
        t?.("llm.notFound") ??
        "Model or endpoint not found — verify base URL and model name."
      );
    }
    if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
      return t?.("llm.rateLimited") ?? "Rate limited — try again shortly.";
    }
    if (
      msg.toLowerCase().includes("network") ||
      msg.toLowerCase().includes("fetch failed") ||
      msg.toLowerCase().includes("failed to fetch")
    ) {
      return t?.("llm.networkError") ?? "Network error — check your connection.";
    }
    if (
      msg.toLowerCase().includes("no endpoints found that support tool use") ||
      msg.toLowerCase().includes("support tool use")
    ) {
      return (
        t?.("llm.toolsNotSupportedOpenRouter") ??
        "No OpenRouter route supports tool calling for this model. Switch to a tool-capable model (e.g. openai/gpt-4o-mini) in Settings → AI Provider."
      );
    }
    if (msg === "An error occurred.") {
      return t?.("agent.errorGeneric") ?? "Request failed — check Settings → AI Provider.";
    }
    return msg;
  }
  if (typeof error === "string") {
    return formatLlmError(new Error(error), t);
  }
  return String(error);
}

/** Unwrap AI SDK masked errors for chat UI. */
export function formatAgentError(error: unknown, t?: TranslateFn): string {
  if (error == null) {
    return t?.("agent.errorUnknown") ?? "Unknown error";
  }
  if (error instanceof Error) {
    return formatLlmError(error, t);
  }
  return formatLlmError(String(error), t);
}

export async function testConnection(
  settings: LlmSettings,
  t?: TranslateFn,
): Promise<string> {
  const modelError = validateModel(settings, t);
  if (modelError) throw new Error(modelError);
  assertApiKey(settings, t);

  try {
    const { text } = await generateText({
      model: resolveModel(settings),
      prompt: "Reply with exactly: OK",
    });
    return text.trim();
  } catch (e) {
    throw new Error(formatLlmError(e, t));
  }
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
    thinkingEnabled: false,
  };
}
