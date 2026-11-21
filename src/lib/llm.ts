import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError, StreamProviderError, generateText, tool, type LanguageModel } from "ai";
import { getAgentRunAbortSignal } from "./agent-abort";
import { CONNECTION_TEST_TIMEOUT_MS } from "./agent-timeouts";
import { isToolModel, isVisionModel } from "./model-capabilities";
import { generateVisionText } from "./vision-api";
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  type LlmSettings,
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

/**
 * Add OpenRouter's server-side web-search plugin to a chat request body. Uses the
 * model's own native search instead of a hand-rolled tool. Non-JSON bodies (e.g. a
 * streamed body) are returned untouched.
 */
export function injectWebSearchPlugin(body: string, maxResults = 3): string {
  try {
    const parsed = JSON.parse(body) as { plugins?: unknown[] };
    const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
    parsed.plugins = [...plugins, { id: "web", max_results: maxResults }];
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * Per-run opt-in web search. Set true just for the runs where the user turned on
 * "search the web" for that message (OpenRouter only); cleared after. This
 * replaces the always-on plugin removed in 3.5.1 — the model only searches when
 * the user asks it to, not on every message.
 */
let webSearchForRun = false;
/** Body that received the run's injection, so SDK retries of that same request keep it. */
let webSearchInjectedBody: string | null = null;
export function setWebSearchForRun(on: boolean): void {
  webSearchForRun = on;
  webSearchInjectedBody = null;
}

/**
 * Consume the run's web-search opt-in for one request body, or return null to
 * leave the request untouched. One user message = one web search: the flag is
 * disarmed on the first injection, so the later tool-loop steps of the same run
 * (up to ~30 chat requests) don't each trigger another billed search. The SDK
 * retries a failed request with an identical body (default maxRetries=2) — that
 * exact body is remembered and re-injected so a transient 429/5xx on the first
 * step doesn't silently drop the user's opt-in. Injection is also scoped to
 * streamed agent-run requests — a connection test or other plain request issued
 * while a web-enabled run streams (agent runs stream; probes don't) never picks
 * up the plugin.
 */
export function takeWebSearchInjection(body: string): string | null {
  if (getAgentRunAbortSignal() == null) return null;
  // SDK retry of the request we already injected: keep the plugin without
  // consuming anything.
  if (webSearchInjectedBody !== null && body === webSearchInjectedBody) {
    return injectWebSearchPlugin(body);
  }
  if (!webSearchForRun) return null;
  let streamed = false;
  try {
    streamed = (JSON.parse(body) as { stream?: unknown }).stream === true;
  } catch {
    return null;
  }
  if (!streamed) return null;
  webSearchForRun = false;
  webSearchInjectedBody = body;
  return injectWebSearchPlugin(body);
}

const MAX_CACHED_REASONING = 256;
const reasoningByToolCallId = new Map<string, string>();

export function __clearDeepseekReasoningCacheForTests(): void {
  reasoningByToolCallId.clear();
}

function rememberDeepseekReasoning(ids: readonly string[], reasoning: string): void {
  for (const id of ids) {
    if (!id) continue;
    if (reasoningByToolCallId.has(id)) reasoningByToolCallId.delete(id);
    reasoningByToolCallId.set(id, reasoning);
    while (reasoningByToolCallId.size > MAX_CACHED_REASONING) {
      const oldest = reasoningByToolCallId.keys().next().value;
      if (oldest === undefined) break;
      reasoningByToolCallId.delete(oldest);
    }
  }
}

function transformProviderRequestBody(settings: LlmSettings, rawBody: string): string {
  const withWeb = settings.provider === "openrouter" ? takeWebSearchInjection(rawBody) : null;
  const source = withWeb ?? rawBody;
  const isOllama = settings.provider === "ollama";
  const isAnthropicRoute =
    settings.provider === "openrouter" &&
    settings.model.trim().toLowerCase().startsWith("anthropic/");
  const isDeepseek = isDeepseekModel(settings);
  if (!isOllama && !isAnthropicRoute && !isDeepseek) return source;

  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    let mutated = false;

    if (isOllama) {
      const existing =
        parsed.options && typeof parsed.options === "object" && !Array.isArray(parsed.options)
          ? (parsed.options as Record<string, unknown>)
          : {};
      if (existing.num_ctx === undefined) {
        parsed.options = { num_ctx: 32_768, ...existing };
        mutated = true;
      }
    }

    if (isAnthropicRoute && Array.isArray(parsed.messages)) {
      for (const m of parsed.messages as Array<Record<string, unknown>>) {
        if (!m || m.role !== "system") continue;
        if (typeof m.content === "string") {
          m.content = [
            { type: "text", text: m.content, cache_control: { type: "ephemeral" } },
          ];
          mutated = true;
        } else if (Array.isArray(m.content) && m.content.length > 0) {
          const last = m.content[m.content.length - 1] as Record<string, unknown>;
          if (last && typeof last === "object" && last.cache_control === undefined) {
            last.cache_control = { type: "ephemeral" };
            mutated = true;
          }
        }
      }
    }

    if (isDeepseek && Array.isArray(parsed.messages)) {
      for (const m of parsed.messages as Array<Record<string, unknown>>) {
        if (
          !m ||
          m.role !== "assistant" ||
          !Array.isArray(m.tool_calls) ||
          m.tool_calls.length === 0 ||
          m.reasoning_content !== undefined
        ) {
          continue;
        }
        let recorded: string | undefined;
        for (const tc of m.tool_calls as Array<{ id?: unknown }>) {
          if (typeof tc?.id === "string") {
            const hit = reasoningByToolCallId.get(tc.id);
            if (hit !== undefined) {
              recorded = hit;
              break;
            }
          }
        }
        if (recorded !== undefined) {
          m.reasoning_content = recorded;
          mutated = true;
        } else if (settings.thinkingEnabled || parsed.reasoning_effort != null) {
          m.reasoning_content = "";
          mutated = true;
        }
      }
    }

    return mutated ? JSON.stringify(parsed) : source;
  } catch {
    return source;
  }
}

async function tapDeepseekResponse(settings: LlmSettings, res: Response): Promise<Response> {
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("text/event-stream") && res.body) {
    const decoder = new TextDecoder();
    let sseBuf = "";
    let reasoningBuf = "";
    const toolCallIds = new Set<string>();

    const consumeLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      try {
        const frame = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              reasoning_content?: unknown;
              tool_calls?: Array<{ id?: unknown }>;
            };
          }>;
        };
        const delta = frame.choices?.[0]?.delta;
        if (!delta) return;
        if (typeof delta.reasoning_content === "string") {
          reasoningBuf += delta.reasoning_content;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (typeof tc?.id === "string" && tc.id) toolCallIds.add(tc.id);
          }
        }
      } catch {
        /* ignore malformed SSE frames */
      }
    };

    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        sseBuf += decoder.decode(chunk, { stream: true });
        let nl = sseBuf.indexOf("\n");
        while (nl >= 0) {
          consumeLine(sseBuf.slice(0, nl));
          sseBuf = sseBuf.slice(nl + 1);
          nl = sseBuf.indexOf("\n");
        }
      },
      flush() {
        sseBuf += decoder.decode();
        if (sseBuf) {
          for (const line of sseBuf.split("\n")) consumeLine(line);
        }
        if (toolCallIds.size > 0 && (reasoningBuf.length > 0 || settings.thinkingEnabled)) {
          rememberDeepseekReasoning([...toolCallIds], reasoningBuf);
        }
      },
    });
    return new Response(res.body.pipeThrough(tap), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  if (ct.includes("application/json")) {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as {
        choices?: Array<{
          message?: {
            reasoning_content?: unknown;
            tool_calls?: Array<{ id?: unknown }>;
          };
        }>;
      };
      const msg = parsed.choices?.[0]?.message;
      const ids = Array.isArray(msg?.tool_calls)
        ? msg.tool_calls
            .map((tc) => (typeof tc?.id === "string" ? tc.id : ""))
            .filter(Boolean)
        : [];
      if (ids.length > 0 && typeof msg?.reasoning_content === "string") {
        rememberDeepseekReasoning(ids, msg.reasoning_content);
      }
    } catch {
      /* ignore non-completion JSON */
    }
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  return res;
}

export function providerFetch(settings: LlmSettings): typeof fetch | undefined {
  if (settings.provider === "openai" || settings.provider === "custom") return undefined;

  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (settings.provider === "openrouter") {
      headers.set("HTTP-Referer", "https://pagewise.app");
      headers.set("X-Title", "PageWise");
    }
    const body =
      typeof init?.body === "string"
        ? transformProviderRequestBody(settings, init.body)
        : init?.body;
    const res = await globalThis.fetch(input, { ...init, headers, body });
    return isDeepseekModel(settings) ? tapDeepseekResponse(settings, res) : res;
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

/** Where the LLM call originated — drives image-error copy (agent vs background scan). */
export type LlmErrorKind = "agent" | "scan" | "general";

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

function imageInputErrorMessage(t: TranslateFn | undefined, kind: LlmErrorKind): string {
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
  if (APICallError.isInstance(error)) {
    const fromBody = parseApiErrorBody(error.responseBody);
    if (fromBody) return new Error(fromBody);
  }
  if (StreamProviderError.isInstance(error) && error.data != null) {
    const fromData = parseApiErrorBody(typeof error.data === "string" ? error.data : JSON.stringify(error.data));
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
    if (APICallError.isInstance(current)) {
      out.url ??= current.url;
      if (typeof current.statusCode === "number") out.statusCode ??= current.statusCode;
      if (current.message.startsWith("Cannot connect to API")) out.cannotConnect = true;
      fieldsFromJson(current.responseBody, out);
      fieldsFromJson(current.data, out);
    } else if (StreamProviderError.isInstance(current)) {
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

/** A reader-facing provider name for "top up at …", from the request URL (24.0). */
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

export function validateModel(
  settings: LlmSettings,
  t?: TranslateFn,
): string | null {
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

export function formatLlmError(
  error: unknown,
  t?: TranslateFn,
  kind: LlmErrorKind = "general",
): string {
  return formatLlmErrorWith(error, t, kind, {});
}

/**
 * `inherited` carries the body's `code` / `type` across the re-entries below
 * that rebuild the error from its message alone (24.0).
 */
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
    (APICallError.isInstance(unwrapped)
      ? unwrapped.statusCode
      : APICallError.isInstance(error)
        ? error.statusCode
        : StreamProviderError.isInstance(error)
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
    // Ollama answers a tools request to a model without tool support with a
    // 400 "registry.ollama.ai/library/<model> does not support tools" (24.0).
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
    // An empty balance is not a rate limit: OpenAI sends it as 429
    // `insufficient_quota`, DeepSeek as 402 "Insufficient Balance", OpenRouter
    // as 402 "requires more credits". Waiting will not help, so this runs
    // before the 429 check and says where to top up (24.0).
    if (
      statusCode === 402 ||
      /insufficient_quota|insufficient_balance|billing_hard_limit/.test(code) ||
      /insufficient (balance|quota|credits?)|exceeded your current quota|requires more credits/i.test(msg)
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
  // An error object that is not an Error — a provider frame passed through as
  // data. `String()` of it is "[object Object]", which says nothing.
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
    throw new Error(imageInputErrorMessage(t, "scan"));
  }

  try {
    return await generateVisionText(
      settings,
      "If you can see an image, reply with exactly OK.",
      VISION_PROBE_JPEG,
      // The only generateVisionText call site with no deadline of its own. The
      // two background ones bound themselves at 60s; this one ran unbounded, so
      // a wrong base URL left the button spinning until the reader gave up.
      { signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS) },
    );
  } catch (e) {
    throw new Error(formatLlmError(e, t, "scan"));
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
    const { z } = await import("zod");
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
      // A health check that has not answered in thirty seconds has answered.
      timeout: CONNECTION_TEST_TIMEOUT_MS,
    });
    return text.trim();
  } catch (e) {
    throw new Error(formatLlmError(e, t));
  }
}
