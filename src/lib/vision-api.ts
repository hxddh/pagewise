import { formatLlmError, resolveBaseURL } from "./llm";
import type { LlmSettings } from "./types";

/** Encode JPEG bytes as a data URL (OpenRouter requires this, not raw base64). */
export function imageBytesToDataUrl(bytes: Uint8Array, mediaType = "image/jpeg"): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
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

/** OpenAI-compatible chat/completions with a single JPEG image (bypasses SDK base64 URL bug). */
export async function generateVisionText(
  settings: LlmSettings,
  prompt: string,
  imageJpeg: Uint8Array,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const baseURL = resolveBaseURL(settings);
  const url = `${baseURL}/chat/completions`;
  const dataUrl = imageBytesToDataUrl(imageJpeg);

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
    return parseChatCompletionText(JSON.parse(raw));
  } catch {
    throw new Error(formatLlmError(new Error("Invalid response from vision model")));
  }
}
