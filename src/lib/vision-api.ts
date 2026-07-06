import { formatLlmError, resolveBaseURL, validateModel } from "./llm";
import { addIndexUsage } from "./usage-tracker";
import type { LlmSettings } from "./types";

/** Encode JPEG bytes as a data URL (OpenRouter requires this, not raw base64). */
export function imageBytesToDataUrl(bytes: Uint8Array, mediaType = "image/jpeg"): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${mediaType};base64,${btoa(binary)}`;
}

function visionHeaders(settings: LlmSettings): HeadersInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${settings.apiKey || (settings.provider === "ollama" ? "ollama" : "")}`,
    "Content-Type": "application/json",
  };
  if (settings.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://pagewise.app";
    headers["X-Title"] = "PageWise";
  }
  return headers;
}

function parseChatCompletionText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const choices = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part && typeof part.text === "string"
          ? part.text
          : "",
      )
      .join("")
      .trim();
  }
  return "";
}

function parseChatCompletionUsage(
  body: unknown,
): { inputTokens?: number; outputTokens?: number } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const usage = (
    body as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
      };
    }
  ).usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens,
    outputTokens: usage.completion_tokens ?? usage.output_tokens,
  };
}

/** OpenAI-compatible chat/completions with a single JPEG image (bypasses SDK base64 URL bug). */
export async function generateVisionText(
  settings: LlmSettings,
  prompt: string,
  imageJpeg: Uint8Array,
  options: { signal?: AbortSignal; mediaType?: string } = {},
): Promise<string> {
  const modelError = validateModel(settings);
  if (modelError) {
    throw new Error(formatLlmError(new Error(modelError), undefined, "scan"));
  }

  const baseURL = resolveBaseURL(settings);
  const url = `${baseURL}/chat/completions`;
  const dataUrl = imageBytesToDataUrl(imageJpeg, options.mediaType ?? "image/jpeg");

  const response = await fetch(url, {
    method: "POST",
    headers: visionHeaders(settings),
    signal: options.signal,
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      /* use raw body */
    }
    throw new Error(formatLlmError(new Error(message || response.statusText)));
  }

  try {
    const parsed = JSON.parse(raw);
    const usage = parseChatCompletionUsage(parsed);
    if (usage) {
      addIndexUsage({
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      });
    }
    return parseChatCompletionText(parsed);
  } catch {
    throw new Error(formatLlmError(new Error("Invalid response from vision model")));
  }
}
