import type { LanguageModelUsage } from "ai";

export interface IndexUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
}

let indexUsage: IndexUsageSnapshot = { inputTokens: 0, outputTokens: 0 };

function addUsage(
  target: IndexUsageSnapshot,
  usage: Pick<LanguageModelUsage, "inputTokens" | "outputTokens"> | undefined,
): void {
  if (!usage) return;
  target.inputTokens += usage.inputTokens ?? 0;
  target.outputTokens += usage.outputTokens ?? 0;
}

export function resetIndexUsageTracker(): void {
  indexUsage = { inputTokens: 0, outputTokens: 0 };
}

export function addIndexUsage(
  usage: Pick<LanguageModelUsage, "inputTokens" | "outputTokens"> | undefined,
): void {
  addUsage(indexUsage, usage);
}

export function getIndexUsageSnapshot(): IndexUsageSnapshot {
  return { ...indexUsage };
}

/**
 * Vision requests sent per document this session.
 *
 * Vision indexing is billed per page image, so the request count — not the token
 * total — is what the user is actually spending. Counted at dispatch: it reports
 * what was sent, which is the number that can surprise someone.
 */
const docVisionCalls = new Map<string, number>();

export function recordVisionCall(path: string): void {
  docVisionCalls.set(path, (docVisionCalls.get(path) ?? 0) + 1);
}

export function getVisionCallCount(path: string): number {
  return docVisionCalls.get(path) ?? 0;
}

export function resetVisionCallCount(path?: string): void {
  if (path === undefined) docVisionCalls.clear();
  else docVisionCalls.delete(path);
}
