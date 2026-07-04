/** Lightweight tools that should not be repeated in a loop without reading. */
export const META_TOOLS = new Set([
  "list_documents",
  "get_document_index",
  "search_in_document",
]);

export const READ_TOOL_NAMES = ["read_pdf_page", "read_pdf_range"] as const;

export const AGENT_TOOL_NAMES = [
  "list_documents",
  "get_document_index",
  "search_in_document",
  ...READ_TOOL_NAMES,
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export type AgentStepSnapshot = {
  toolCalls?: Array<{ toolName?: string }>;
  text?: string;
};

export function countToolCalls(steps: AgentStepSnapshot[], toolName: string): number {
  let count = 0;
  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      if (call.toolName === toolName) count += 1;
    }
  }
  return count;
}

export function hasReadToolInSteps(steps: AgentStepSnapshot[]): boolean {
  for (const step of steps) {
    for (const call of step.toolCalls ?? []) {
      if (call.toolName && READ_TOOL_NAMES.includes(call.toolName as (typeof READ_TOOL_NAMES)[number])) {
        return true;
      }
    }
  }
  return false;
}

function stepUsesOnlyMetaTools(step: AgentStepSnapshot): boolean {
  const calls = step.toolCalls ?? [];
  if (calls.length === 0) return false;
  return calls.every((call) => call.toolName && META_TOOLS.has(call.toolName));
}

/** True when recent steps keep calling list/index/search without reading pages. */
export function isMetaToolOnlyLoop(steps: AgentStepSnapshot[], window = 3): boolean {
  if (steps.length < window) return false;
  const recent = steps.slice(-window);
  if (!recent.every(stepUsesOnlyMetaTools)) return false;
  return !hasReadToolInSteps(steps);
}

/** After search, force the model to read pages instead of searching again. */
export function shouldForceReadTools(steps: AgentStepSnapshot[]): boolean {
  if (countToolCalls(steps, "search_in_document") < 1) return false;
  return !hasReadToolInSteps(steps);
}

const ONE_TIME_META_TOOLS = ["list_documents", "get_document_index"] as const;

/** Hide list/index once already called this turn. */
export function getBlockedMetaTools(steps: AgentStepSnapshot[]): AgentToolName[] {
  const blocked: AgentToolName[] = [];
  for (const name of ONE_TIME_META_TOOLS) {
    if (countToolCalls(steps, name) > 0) blocked.push(name);
  }
  return blocked;
}

const DSML_START_RE = /<\s*\|+\s*DSML/i;
/**
 * The real leaked opening: a `<|DSML|` delimiter directly introducing an
 * `invoke name=` token, e.g. `<|DSML|invoke name="list_documents">`. Requiring
 * this actual adjacency (rather than two independent substrings) avoids cutting
 * legitimate prose that merely mentions "DSML" and "invoke name=" separately.
 */
const DSML_INVOKE_RE = /<\s*\|+\s*DSML\|*\s*invoke\s+name=/i;

/** DeepSeek / some providers leak tool XML as plain text — hide from chat UI. */
export function stripDsmlToolMarkup(text: string): string {
  if (!isDsmlToolLeak(text)) return text;
  const idx = text.search(DSML_START_RE);
  if (idx === -1) {
    return text
      .replace(/<\s*\|+\s*DSML[\s\S]*$/gi, "")
      .replace(/<\/\s*\|+\s*DSML[^>]*>/gi, "")
      .trim();
  }
  return text.slice(0, idx).trim();
}

export function isDsmlToolLeak(text: string): boolean {
  return DSML_INVOKE_RE.test(text);
}
