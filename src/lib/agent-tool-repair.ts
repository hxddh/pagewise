/**
 * Deterministic, model-agnostic normalizers for document tool calls.
 *
 * Weak OpenAI-compatible models (DeepSeek, Ollama, some OpenRouter routes)
 * routinely emit numeric arguments as strings or invert a page range. Rather
 * than burn a step on a schema error, we repair the common shapes in code
 * before the call reaches the tool. These helpers are pure so they can be
 * unit-tested without a live model.
 */

/** Tool-input fields that must be numbers across the document tools. */
const NUMERIC_TOOL_FIELDS = ["page", "start", "end", "offset", "maxChars", "maxResults"] as const;

/**
 * Coerce string-encoded numeric fields in a tool-call argument JSON string.
 * Returns the repaired JSON string, or null when nothing could be fixed
 * (unparseable, not an object, or no numeric-looking string field).
 */
export function coerceNumericToolInput(inputJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  let changed = false;
  for (const field of NUMERIC_TOOL_FIELDS) {
    const value = obj[field];
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      obj[field] = Number(value);
      changed = true;
    }
  }
  return changed ? JSON.stringify(obj) : null;
}

/**
 * Normalize a read_pdf_range input: an inverted range (start > end) is swapped
 * so the read succeeds instead of throwing. The character offset only refers to
 * the original start page, so it is dropped once the pages swap.
 */
export function normalizeRangeInput<
  T extends { start: number; end: number; offset?: number },
>(input: T): T {
  if (input.start > input.end) {
    return { ...input, start: input.end, end: input.start, offset: 0 };
  }
  return input;
}
