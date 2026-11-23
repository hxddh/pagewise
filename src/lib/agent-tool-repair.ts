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
const NUMERIC_TOOL_FIELDS = [
  "page",
  "start",
  "end",
  "offset",
  "maxChars",
  "maxResults",
  "index",
] as const;

const BOOLEAN_TOOL_FIELDS = ["fullPage", "previews", "pageStats"] as const;

function parsePageToken(raw: string): number[] | null {
  const trimmed = raw.trim().replace(/^(?:pages?|p\.?)\s*/i, "");
  if (!trimmed) return null;
  const range = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(trimmed);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi - lo > 20) return null;
    const out: number[] = [];
    for (let p = lo; p <= hi; p += 1) out.push(p);
    return out;
  }
  const n = Number(trimmed);
  return Number.isInteger(n) ? [n] : null;
}

/**
 * Coerce string-encoded numeric/boolean fields (and string/scalar/range `pages`
 * arrays) in a tool-call argument JSON string. Returns the repaired JSON string,
 * or null when nothing could be fixed.
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
    if (typeof value === "string" && value.trim() !== "") {
      const stripped =
        field === "page" || field === "start" || field === "end"
          ? value.trim().replace(/^(?:page|p\.?)\s*/i, "")
          : value.trim();
      if (stripped !== "" && Number.isFinite(Number(stripped))) {
        obj[field] = Number(stripped);
        changed = true;
      }
    }
  }
  for (const field of BOOLEAN_TOOL_FIELDS) {
    const value = obj[field];
    if (value === "true" || value === "false") {
      obj[field] = value === "true";
      changed = true;
    }
  }
  const pages = obj.pages;
  if (typeof pages === "number" && Number.isFinite(pages)) {
    obj.pages = [pages];
    changed = true;
  } else if (typeof pages === "string" && pages.trim() !== "") {
    const parts = pages.split(/[\s,]+/).filter(Boolean);
    const nums: number[] = [];
    let ok = parts.length > 0;
    for (const part of parts) {
      const expanded = parsePageToken(part);
      if (!expanded) {
        ok = false;
        break;
      }
      nums.push(...expanded);
    }
    if (ok && nums.length > 0) {
      obj.pages = nums;
      changed = true;
    }
  } else if (Array.isArray(pages) && pages.some((p) => typeof p === "string")) {
    const nums: number[] = [];
    let ok = true;
    for (const p of pages) {
      if (typeof p === "number" && Number.isFinite(p)) {
        nums.push(p);
      } else if (typeof p === "string") {
        const expanded = parsePageToken(p);
        if (!expanded) {
          ok = false;
          break;
        }
        nums.push(...expanded);
      } else {
        ok = false;
        break;
      }
    }
    if (ok && nums.length > 0) {
      obj.pages = nums;
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
