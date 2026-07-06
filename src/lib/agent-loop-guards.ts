import {
  DOCUMENT_OUTLINE_TOOL,
  DOCUMENT_TOOL_NAMES,
  READ_PDF_PAGE_TOOL,
  READ_PDF_RANGE_TOOL,
  SEARCH_IN_DOCUMENT_TOOL,
  type DocumentToolName,
} from "./document-tool-names";

/** Lightweight tools that should not be repeated in a loop without reading. */
export const META_TOOLS = new Set<DocumentToolName>([
  DOCUMENT_OUTLINE_TOOL,
  SEARCH_IN_DOCUMENT_TOOL,
]);

export const READ_TOOL_NAMES = [READ_PDF_PAGE_TOOL, READ_PDF_RANGE_TOOL] as const;

export const AGENT_TOOL_NAMES = [...DOCUMENT_TOOL_NAMES] as const;

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
  return calls.every((call) => call.toolName && META_TOOLS.has(call.toolName as DocumentToolName));
}

/** True when recent steps keep calling outline/search without reading pages. */
export function isMetaToolOnlyLoop(steps: AgentStepSnapshot[], window = 3): boolean {
  if (steps.length < window) return false;
  const recent = steps.slice(-window);
  if (!recent.every(stepUsesOnlyMetaTools)) return false;
  return !hasReadToolInSteps(steps);
}

/** After search, force the model to read pages instead of searching again. */
export function shouldForceReadTools(steps: AgentStepSnapshot[]): boolean {
  if (countToolCalls(steps, SEARCH_IN_DOCUMENT_TOOL) < 1) return false;
  return !hasReadToolInSteps(steps);
}

const ONE_TIME_META_TOOLS = [DOCUMENT_OUTLINE_TOOL] as const;

/** Hide outline once already called this turn. */
export function getBlockedMetaTools(steps: AgentStepSnapshot[]): AgentToolName[] {
  const blocked: AgentToolName[] = [];
  for (const name of ONE_TIME_META_TOOLS) {
    if (countToolCalls(steps, name) > 0) blocked.push(name);
  }
  return blocked;
}

/**
 * Pipe-delimited DSML tags — compact `<|DSML|` or spaced `< | | DSML | |`.
 * Some providers tokenize the delimiter with spaces between pipes.
 */
const DSML_TAG_OPEN = /<(?:\s*\|)+\s*DSML(?:\s*\|)+/i;

/**
 * Leaked tool-call opening: DSML delimiter directly introducing `invoke name=`.
 * Requires adjacency so prose that merely mentions "DSML" and "invoke name=" is not stripped.
 */
const DSML_INVOKE_RE = /<(?:\s*\|)+\s*DSML(?:\s*\|)+\s*invoke\s+name=/i;

/** DeepSeek / some providers leak tool XML as plain text — hide from chat UI. */
export function stripDsmlToolMarkup(text: string): string {
  if (!isDsmlToolLeak(text)) return text;
  const idx = text.search(DSML_TAG_OPEN);
  if (idx === -1) {
    return text
      .replace(/<(?:\s*\|)+\s*DSML[\s\S]*$/gi, "")
      .replace(/<\/(?:\s*\|)+\s*DSML[^>]*>/gi, "")
      .trim();
  }
  return text.slice(0, idx).trim();
}

export function isDsmlToolLeak(text: string): boolean {
  return DSML_INVOKE_RE.test(text);
}

/** True when assistant text is only leaked DSML (no user-visible answer). */
export function isDsmlOnlyAssistantText(text?: string): boolean {
  const raw = text?.trim();
  if (!raw) return false;
  return isDsmlToolLeak(raw) && !stripDsmlToolMarkup(raw);
}
