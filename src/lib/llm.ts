import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError, generateText, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { isToolModel, isVisionModel } from "./model-capabilities";
import { generateVisionText } from "./vision-api";
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
    if (
      msg.toLowerCase().includes("does not support image") ||
      msg.toLowerCase().includes("multimodal") ||
      msg.toLowerCase().includes("image input")
    ) {
      return (
        t?.("llm.visionNotSupported") ??
        "This model does not support image input — pick another scan model in Settings → AI Provider."
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

/** Minimal valid JPEG for scan-model connectivity checks. */
const VISION_PROBE_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
  0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20, 0x24, 0x2e, 0x27, 0x20,
  0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29, 0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27,
  0x39, 0x3d, 0x38, 0x32, 0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
  0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03, 0x00,
  0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32,
  0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
  0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35,
  0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
  0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
  0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94,
  0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2,
  0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
  0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6,
  0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda,
  0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xfb, 0xd5, 0xdb, 0x20, 0xa8, 0xf8, 0x07, 0xff,
  0xd9,
]);

/** Verify the scan (vision) model can read a tiny image payload. */
export async function testVisionConnection(
  settings: LlmSettings,
  t?: TranslateFn,
): Promise<string> {
  assertApiKey(settings, t);
  if (!settings.model.trim()) {
    throw new Error(t?.("llm.modelRequired") ?? "Model ID is required");
  }
  if (!isVisionModel(settings.provider, settings.model)) {
    throw new Error(
      t?.("llm.visionNotSupported") ??
        "This model does not support image input — pick another scan model in Settings → AI Provider.",
    );
  }

  try {
    return await generateVisionText(
      settings,
      "If you can see an image, reply with exactly OK.",
      VISION_PROBE_JPEG,
    );
  } catch (e) {
    throw new Error(formatLlmError(e, t));
  }
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
