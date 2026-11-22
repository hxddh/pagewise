import { isToolModel } from "./model-capabilities";
import { PROVIDER_PRESETS, type LlmSettings } from "./types";

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

/** Where the LLM call originated — drives image-error copy (agent vs background scan). */
export type LlmErrorKind = "agent" | "scan" | "general";

const API_CALL_ERROR_SYM = Symbol.for("vercel.ai.error.AI_APICallError");
const STREAM_PROVIDER_ERROR_SYM = Symbol.for("vercel.ai.error.AI_StreamProviderError");

interface ApiCallErrorLike extends Error {
  url?: string;
  statusCode?: number;
  responseBody?: unknown;
  data?: unknown;
}

interface StreamProviderErrorLike extends Error {
  statusCode?: number;
  data?: unknown;
}

function isApiCallError(err: unknown): err is ApiCallErrorLike {
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<PropertyKey, unknown>;
  return rec[API_CALL_ERROR_SYM] === true || rec.name === "AI_APICallError";
}

function isStreamProviderError(err: unknown): err is StreamProviderErrorLike {
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<PropertyKey, unknown>;
  return rec[STREAM_PROVIDER_ERROR_SYM] === true || rec.name === "AI_StreamProviderError";
}

/** Chat Completions base URL (no trailing slash). DeepSeek uses /chat/completions, not /v1. */
export function resolveBaseURL(settings: LlmSettings): string {
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

export function assertApiKey(settings: LlmSettings, t?: TranslateFn): void {
  if (settings.provider === "ollama") return;
  if (!settings.apiKey.trim()) {
    throw new Error(t?.("llm.apiKeyRequired") ?? "API key is required");
  }
}

/** Validate API key before agent send (surfaces error in chat instead of hanging). */
export function assertApiKeyForAgent(settings: LlmSettings, t?: TranslateFn): void {
  assertApiKey(settings, t);
}

/** True when the provider rejected a multimodal / image payload. */
export function isImageInputError(error: unknown): boolean {
  const unwrapped = unwrapApiError(error);
  const msg = unwrapped instanceof Error ? unwrapped.message : String(unwrapped);
  const m = msg.toLowerCase();
  if (m.includes("does not support image") || m.includes("image input")) return true;
  if (m.includes("failed to download image")) return true;
  if (m.includes("multimodal") && (m.includes("not support") || m.includes("unsupported"))) {
    return true;
  }
  if (
    m.includes("vision") &&
    (m.includes("not support") || m.includes("unsupported") || m.includes("not allowed"))
  ) {
    return true;
  }
  return false;
}

export function imageInputErrorMessage(t: TranslateFn | undefined, kind: LlmErrorKind): string {
  if (kind === "agent") {
    return (
      t?.("llm.agentImageNotSupported") ??
      "The assistant model rejected the page screenshot — turn off “Include current page when asking” in Settings → General, or switch to a multimodal agent model (e.g. openai/gpt-4o-mini). Indexed page text still works."
    );
  }
  return (
    t?.("llm.visionNotSupported") ??
    "This model does not support image input — pick another scan model in Settings → Assistant → Advanced."
  );
}

function parseApiErrorBody(body: unknown): string | null {
  if (!body) return null;
  const text = typeof body === "string" ? body : null;
  if (!text?.trim()) return null;
  try {
    const parsed = JSON.parse(text) as {
      error?: {
        message?: string;
        metadata?: { raw?: unknown; provider_name?: unknown };
      };
      message?: string;
    };
    const raw = parsed.error?.metadata?.raw;
    if (typeof raw === "string" && raw.trim()) {
      const trimmed = raw.trim();
      if (trimmed.toLowerCase() !== "provider returned error") {
        return trimmed;
      }
    }
    const msg = parsed.error?.message ?? parsed.message;
    if (typeof msg === "string" && msg.trim()) {
      const provider = parsed.error?.metadata?.provider_name;
      if (
        typeof provider === "string" &&
        provider.trim() &&
        msg.trim().toLowerCase() === "provider returned error"
      ) {
        return `${msg.trim()} (${provider.trim()})`;
      }
      return msg.trim();
    }
  } catch {
    return null;
  }
  return null;
}

function nextErrorInChain(err: unknown): unknown {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { lastError?: unknown; errors?: unknown[]; cause?: unknown };
  if (e.lastError && e.lastError !== err) return e.lastError;
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    const last = e.errors[e.errors.length - 1];
    if (last && last !== err) return last;
  }
  if (e.cause && e.cause !== err) return e.cause;
  return undefined;
}

function unwrapApiError(error: unknown): unknown {
  if (isApiCallError(error)) {
    const fromBody = parseApiErrorBody(error.responseBody);
    if (fromBody) return new Error(fromBody);
  }
  if (isStreamProviderError(error) && error.data != null) {
    const fromData = parseApiErrorBody(
      typeof error.data === "string" ? error.data : JSON.stringify(error.data),
    );
    if (fromData && fromData !== error.message) return new Error(fromData);
  }
  if (error instanceof Error) {
    const next = nextErrorInChain(error);
    if (next) return unwrapApiError(next);
  }
  return error;
}

interface ApiErrorFields {
  code?: string;
  type?: string;
  url?: string;
  statusCode?: number;
  cannotConnect?: boolean;
}

function fieldsFromJson(value: unknown, out: ApiErrorFields): void {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return;
    }
  }
  if (!parsed || typeof parsed !== "object") return;
  const root = parsed as { error?: unknown; code?: unknown; type?: unknown };
  const inner =
    root.error && typeof root.error === "object"
      ? (root.error as { code?: unknown; type?: unknown })
      : root;
  if (out.code === undefined && (typeof inner.code === "string" || typeof inner.code === "number")) {
    out.code = String(inner.code);
  }
  if (out.type === undefined && typeof inner.type === "string") out.type = inner.type;
}

function readApiErrorFields(error: unknown): ApiErrorFields {
  const out: ApiErrorFields = {};
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if (isApiCallError(current)) {
      out.url ??= current.url;
      if (typeof current.statusCode === "number") out.statusCode ??= current.statusCode;
      if (current.message.startsWith("Cannot connect to API")) out.cannotConnect = true;
      fieldsFromJson(current.responseBody, out);
      fieldsFromJson(current.data, out);
    } else if (isStreamProviderError(current)) {
      if (typeof current.statusCode === "number") out.statusCode ??= current.statusCode;
      fieldsFromJson(current.data, out);
    } else if (current instanceof Error) {
      const errCode = (current as Error & { code?: unknown }).code;
      if (out.code === undefined && typeof errCode === "string") out.code = errCode;
      if (current.message.startsWith("Cannot connect to API")) out.cannotConnect = true;
    } else {
      fieldsFromJson(current, out);
    }
    current = nextErrorInChain(current);
  }
  return out;
}

function providerNameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (host.endsWith("deepseek.com")) return "DeepSeek";
  if (host.endsWith("openai.com")) return "OpenAI";
  if (host.endsWith("openrouter.ai")) return "OpenRouter";
  return host || undefined;
}

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

export function validateModel(settings: LlmSettings, t?: TranslateFn): string | null {
  if (!settings.model.trim()) {
    return t?.("llm.modelRequired") ?? "Model ID is required";
  }
  if (settings.provider === "custom") {
    if (!resolveBaseURL(settings).trim()) {
      return t?.("llm.baseUrlRequired") ?? "Base URL is required";
    }
    return null;
  }
  return null;
}

export function validateAgentModel(settings: LlmSettings, t?: TranslateFn): string | null {
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

export function formatLlmError(
  error: unknown,
  t?: TranslateFn,
  kind: LlmErrorKind = "general",
): string {
  return formatLlmErrorWith(error, t, kind, {});
}

function formatLlmErrorWith(
  error: unknown,
  t: TranslateFn | undefined,
  kind: LlmErrorKind,
  inherited: ApiErrorFields,
): string {
  const unwrapped = unwrapApiError(error);
  const fields = { ...inherited, ...readApiErrorFields(error) };
  const statusCode =
    fields.statusCode ??
    (isApiCallError(unwrapped)
      ? unwrapped.statusCode
      : isApiCallError(error)
        ? error.statusCode
        : isStreamProviderError(error)
          ? error.statusCode
          : undefined);
  const hasStatus = typeof statusCode === "number";
  const code = `${fields.code ?? ""} ${fields.type ?? ""}`.toLowerCase();

  if (unwrapped instanceof Error) {
    const msg = unwrapped.message;
    const lower = msg.toLowerCase();
    if (msg === "An error occurred.") {
      const cause = (unwrapped as Error & { cause?: unknown }).cause;
      if (cause) return formatLlmErrorWith(cause, t, kind, fields);
    }
    if (isImageInputError(unwrapped)) {
      return imageInputErrorMessage(t, kind);
    }
    if (
      msg === "Provider returned error" ||
      msg.toLowerCase() === "provider returned error" ||
      /^Provider returned error\s*\(/i.test(msg)
    ) {
      return (
        t?.("llm.providerReturnedError") ??
        "The upstream model provider rejected the request — try openai/gpt-4o-mini (OpenRouter), another provider, or retry shortly. Page context still works via text when “Include current page” is on."
      );
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
        t?.("llm.invalidApiKey") ?? "Invalid API key — check Settings → Assistant → Advanced."
      );
    }
    if (
      msg.toLowerCase().includes("no endpoints found that support tool use") ||
      msg.toLowerCase().includes("support tool use")
    ) {
      return (
        t?.("llm.toolsNotSupportedOpenRouter") ??
        "No OpenRouter route supports tool calling for this model. Switch to a tool-capable model (e.g. openai/gpt-4o-mini) in Settings → Assistant → Advanced."
      );
    }
    if (lower.includes("does not support tools")) {
      return (
        t?.("llm.modelNoTools") ??
        "This model can’t use tools, which the assistant needs — choose a model that supports tools in Settings → Assistant."
      );
    }
    if (statusCode === 404 || (!hasStatus && msg.includes("404"))) {
      return (
        t?.("llm.notFound") ??
        "Model or endpoint not found — verify base URL and model name."
      );
    }
    if (
      statusCode === 402 ||
      /insufficient_quota|insufficient_balance|billing_hard_limit/.test(code) ||
      /insufficient (balance|quota|credits?)|exceeded your current quota|requires more credits/i.test(
        msg,
      )
    ) {
      const provider = providerNameFromUrl(fields.url);
      return provider
        ? (t?.("llm.insufficientBalance", { provider }) ??
            `Your ${provider} account is out of credit — top up your balance at ${provider}, then try again.`)
        : (t?.("llm.insufficientBalanceGeneric") ??
            "Your provider account is out of credit — top up your balance with the provider, then try again.");
    }
    if (
      statusCode === 429 ||
      (!hasStatus && (msg.includes("429") || lower.includes("rate limit")))
    ) {
      return t?.("llm.rateLimited") ?? "Rate limited — try again shortly.";
    }
    if (
      statusCode === 503 ||
      statusCode === 529 ||
      /overloaded/.test(code) ||
      ((statusCode === 502 || statusCode === 504) &&
        (/<html\b|<!doctype\b/i.test(msg) ||
          /bad gateway|gateway time-?out|connection refused|timed out|upstream connect error/i.test(
            msg,
          ))) ||
      (!hasStatus && /server overloaded|service unavailable/i.test(msg))
    ) {
      return (
        t?.("llm.providerOverloaded") ??
        "The provider is overloaded right now — try again in a minute."
      );
    }
    if (
      /context_length_exceeded|context_too_long|prompt_too_long/.test(code) ||
      /maximum context length|exceeds (the )?(model'?s? )?context (length|window)|prompt is too long|input is too long|too many tokens/i.test(
        msg,
      )
    ) {
      return (
        t?.("llm.contextTooLong") ??
        "The conversation is too long for this model — start a new chat, or choose a model with a larger context window."
      );
    }
    if (
      !hasStatus &&
      (lower.includes("network") ||
        lower.includes("fetch failed") ||
        lower.includes("failed to fetch") ||
        lower.includes("load failed") ||
        lower.includes("econnrefused") ||
        lower.includes("connection refused") ||
        lower.includes("enotfound") ||
        /econnrefused|enotfound|econnreset|etimedout/.test(code) ||
        fields.cannotConnect)
    ) {
      if (isLocalUrl(fields.url)) {
        return (
          t?.("llm.localServerUnreachable") ??
          "Could not reach the local model server — is Ollama running?"
        );
      }
      return (
        t?.("llm.networkError") ??
        "Network error — check your connection. Using Ollama? Make sure it is running."
      );
    }
    if (
      msg.toLowerCase().includes("reasoning_effort") ||
      msg.toLowerCase().includes("unknown variant `none`")
    ) {
      return (
        t?.("llm.reasoningNotSupported") ??
        "This provider does not support the reasoning setting — turn off Extended thinking in Settings → Assistant → Advanced."
      );
    }
    return msg;
  }
  if (typeof error === "string") {
    return formatLlmErrorWith(new Error(error), t, kind, fields);
  }
  if (error && typeof error === "object") {
    const fromObject = parseApiErrorBody(JSON.stringify(error));
    if (fromObject) return formatLlmErrorWith(new Error(fromObject), t, kind, fields);
  }
  return String(error);
}

/** Unwrap AI SDK masked errors for chat UI. */
export function formatAgentError(error: unknown, t?: TranslateFn): string {
  if (error == null) {
    return t?.("agent.errorUnknown") ?? "Unknown error";
  }
  if (error instanceof Error || typeof error === "object") {
    return formatLlmError(error, t, "agent");
  }
  return formatLlmError(String(error), t, "agent");
}
