import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError, generateText, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { isToolModel } from "./model-capabilities";
import {
  allProviderModels,
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  type LlmSettings,
  type ProviderId,
} from "./types";

/** A DeepSeek model (either the DeepSeek provider, or an OpenRouter `deepseek/*` route). */
function isDeepseekModel(settings: LlmSettings): boolean {
  if (settings.provider === "deepseek") return true;
  if (settings.provider === "openrouter") return settings.model.startsWith("deepseek/");
  return false;
}

/** Portable reasoning control for generate/stream/agent calls. */
export function resolveReasoning(
  settings: LlmSettings,
): LanguageModelV4CallOptions["reasoning"] | undefined {
  if (!settings.thinkingEnabled) return undefined;

  const model = settings.model.toLowerCase();
  if (
    model.includes("pro") ||
    model.includes("opus") ||
    model.includes("v4-pro") ||
    (isDeepseekModel(settings) && model.includes("reasoner"))
  ) {
    return "high";
  }
  return "medium";
}

function providerFetch(settings: LlmSettings): typeof fetch | undefined {
  if (settings.provider !== "openrouter") return undefined;

  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("HTTP-Referer", "https://pagewise.app");
    headers.set("X-Title", "PageWise");
    return fetch(input, { ...init, headers });
  };
}

/** Chat Completions base URL (no trailing slash). DeepSeek uses /chat/completions, not /v1. */
export function resolveBaseURL(settings: LlmSettings): string {
  // Custom providers have no preset: an empty Base URL must stay empty (never silently
  // fall back to OpenAI), so the "Base URL required" validation actually triggers and no
  // request/key is ever sent to api.openai.com.
  if (settings.provider === "custom") {
    return (settings.baseURL?.trim() ?? "").replace(/\/+$/, "");
  }

  const preset = PROVIDER_PRESETS[settings.provider];
  let baseURL = settings.baseURL?.trim() || preset.baseURL;

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

/** Validate API key before agent send (surfaces error in chat instead of hanging). */
export function assertApiKeyForAgent(settings: LlmSettings, t?: TranslateFn): void {
  assertApiKey(settings, t);
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
  // Prefer the AI SDK's structured status code; substring digit matching (e.g. "429") is
  // only a fallback, since a model id like "gpt-4-0429" would otherwise be misclassified.
  const statusCode = APICallError.isInstance(error) ? error.statusCode : undefined;
  const hasStatus = typeof statusCode === "number";

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
    if (
      statusCode === 401 ||
      statusCode === 403 ||
      (!hasStatus && (msg.includes("401") || msg.toLowerCase().includes("authentication")))
    ) {
      return (
        t?.("llm.invalidApiKey") ?? "Invalid API key — check Settings → AI Provider."
      );
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
    if (statusCode === 404 || (!hasStatus && msg.includes("404"))) {
      return (
        t?.("llm.notFound") ??
        "Model or endpoint not found — verify base URL and model name."
      );
    }
    if (
      statusCode === 429 ||
      (!hasStatus && (msg.includes("429") || msg.toLowerCase().includes("rate limit")))
    ) {
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
      msg.toLowerCase().includes("reasoning_effort") ||
      msg.toLowerCase().includes("unknown variant `none`")
    ) {
      return (
        t?.("llm.reasoningNotSupported") ??
        "This provider does not support the reasoning setting — turn off Extended thinking in Settings → AI Provider."
      );
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
  const modelError = validateAgentModel(settings, t);
  if (modelError) throw new Error(modelError);
  assertApiKey(settings, t);

  try {
    const { text } = await generateText({
      model: resolveModel(settings),
      reasoning: resolveReasoning(settings),
      tools: {
        ping: tool({
          description: "Health check — reply with pong",
          inputSchema: z.object({}),
          execute: async () => "pong",
        }),
      },
      prompt: "Call the ping tool once, then reply OK.",
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
