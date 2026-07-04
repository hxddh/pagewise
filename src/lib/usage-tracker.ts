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
