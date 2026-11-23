import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { generateText, tool, type LanguageModel } from "ai";
import { getAgentRunAbortSignal } from "./agent-abort";
import { CONNECTION_TEST_TIMEOUT_MS } from "./agent-timeouts";
import {
  assertApiKey,
  assertApiKeyForAgent,
  formatAgentError,
  formatLlmError,
  imageInputErrorMessage,
  isImageInputError,
  resolveBaseURL,
  validateAgentModel,
  validateModel,
  type LlmErrorKind,
  type TranslateFn,
} from "./llm-errors";
import { isVisionModel } from "./model-capabilities";
import { generateVisionText } from "./vision-api";
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  type LlmSettings,
} from "./types";

export {
  assertApiKeyForAgent,
  formatAgentError,
  formatLlmError,
  isImageInputError,
  resolveBaseURL,
  validateAgentModel,
  validateModel,
  type LlmErrorKind,
  type TranslateFn,
};

/** A DeepSeek model (DeepSeek provider, OpenRouter `deepseek/*`, or self-hosted `custom` DeepSeek). */
function isDeepseekModel(settings: LlmSettings): boolean {
  if (settings.provider === "deepseek") return true;
  if (settings.provider === "openrouter") return settings.model.toLowerCase().startsWith("deepseek/");
  if (settings.provider === "custom") return settings.model.toLowerCase().includes("deepseek");
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
  const lowerModel = settings.model.trim().toLowerCase();
  const isEphemeralCacheRoute =
    settings.provider === "openrouter" &&
    (lowerModel.startsWith("anthropic/") || lowerModel.startsWith("google/gemini-"));
  const isDeepseek = isDeepseekModel(settings);
  if (!isOllama && !isEphemeralCacheRoute && !isDeepseek) return source;

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

    if (isEphemeralCacheRoute && Array.isArray(parsed.messages)) {
      const msgs = parsed.messages as Array<Record<string, unknown>>;
      const markCacheEphemeral = (m: Record<string, unknown> | undefined): boolean => {
        if (!m) return false;
        if (typeof m.content === "string") {
          // Never wrap an empty string: Anthropic rejects `{ type: "text", text: "" }` with HTTP 400.
          if (m.content.length === 0) return false;
          m.content = [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }];
          mutated = true;
          return true;
        }
        if (Array.isArray(m.content) && m.content.length > 0) {
          for (let k = m.content.length - 1; k >= 0; k -= 1) {
            const block = m.content[k] as Record<string, unknown> | undefined;
            if (!block || typeof block !== "object") continue;
            if (block.type === "text" && typeof block.text === "string" && block.text.length === 0) {
              continue;
            }
            if (block.cache_control === undefined) {
              block.cache_control = { type: "ephemeral" };
              mutated = true;
            }
            return true;
          }
        }
        return false;
      };
      for (const m of msgs) {
        if (m && m.role === "system") markCacheEphemeral(m);
      }
      // Place the rolling conversation cache breakpoint on the latest non-empty
      // non-system message (`user` on step 1, latest `tool` result on step 2..N)
      // so every tool-loop step hits 100% of prior context and caches the newest
      // tool output for the next step without failing on `content: null` assistant turns (30.0).
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const candidate = msgs[i];
        if (!candidate || candidate.role === "system") continue;
        if (markCacheEphemeral(candidate)) break;
      }
    }

    if (isDeepseek && Array.isArray(parsed.messages)) {
      const msgs = parsed.messages as Array<Record<string, unknown>>;
      // DeepSeek requires `reasoning_content` ONLY on assistant tool-call steps
      // within the CURRENT user turn, and explicitly recommends omitting prior
      // turns' `reasoning_content` so historical CoT tokens are not re-billed (28.0).
      let activeTurnStart = 0;
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const msg = msgs[i];
        if (!msg || msg.role !== "user") continue;
        const text =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .map((p) =>
                    p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
                      ? (p as { text: string }).text
                      : "",
                  )
                  .join("\n")
              : "";
        if (text.startsWith("The reader interrupted while you were working and said:\n")) {
          continue;
        }
        activeTurnStart = i;
        break;
      }

      for (let i = 0; i < msgs.length; i += 1) {
        const m = msgs[i];
        if (
          !m ||
          m.role !== "assistant" ||
          !Array.isArray(m.tool_calls) ||
          m.tool_calls.length === 0
        ) {
          continue;
        }
        if (i < activeTurnStart) {
          if (m.reasoning_content !== undefined) {
            delete m.reasoning_content;
            mutated = true;
          }
          continue;
        }
        if (m.reasoning_content !== undefined) continue;
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
  if (settings.provider === "openai") return undefined;
  if (settings.provider === "custom" && !isDeepseekModel(settings)) return undefined;

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
