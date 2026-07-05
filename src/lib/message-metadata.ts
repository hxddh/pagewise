import type { UIMessage } from "ai";
import type { StructuredCitation } from "./structured-citations";
import { getIndexUsageSnapshot, resetIndexUsageTracker } from "./usage-tracker";

/** Per agent-loop step usage (debug; persisted with chat sessions). */
export interface StepUsageEntry {
  step: number;
  inputTokens?: number;
  outputTokens?: number;
  toolNames?: string[];
}

/** Per-assistant-message usage and timing (persisted with chat sessions). */
export interface PageWiseMessageMetadata {
  /** Wall-clock when the model run started. */
  startedAt?: number;
  /** Wall-clock when the first text/reasoning token arrived. */
  firstTokenAt?: number;
  /** Wall-clock when the run finished (or was stopped). */
  finishedAt?: number;
  /** Agent loop tokens (from provider finish event). */
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Vision / OCR index tokens during this assistant turn. */
  indexInputTokens?: number;
  indexOutputTokens?: number;
  /** Model id at send time (for display only). */
  model?: string;
  /** True when input includes tool-loop context, not just the user turn. */
  includesToolContext?: boolean;
  /** Structured citations extracted post-reply via streamObject. */
  structuredCitations?: StructuredCitation[];
  /** Provider-specific metadata from the final model response (AI SDK). */
  providerMetadata?: Record<string, unknown>;
  /** Tool names invoked on the agent loop's final step. */
  finalStepTools?: string[];
  /** Per-step token usage from agent onStepEnd (debug). */
  stepUsage?: StepUsageEntry[];
}

export type PageWiseUIMessage = UIMessage<PageWiseMessageMetadata>;

export function getPageWiseMetadata(
  message: UIMessage,
): PageWiseMessageMetadata | undefined {
  const raw = (message as PageWiseUIMessage).metadata;
  if (!raw || typeof raw !== "object") return undefined;
  return raw;
}

export function formatDuration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokenCount(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString();
}

export function computeTotalDurationMs(
  metadata: PageWiseMessageMetadata,
  nowMs = Date.now(),
): number | undefined {
  if (metadata.startedAt == null) return undefined;
  const end = metadata.finishedAt ?? nowMs;
  return Math.max(0, end - metadata.startedAt);
}

export function computeTimeToFirstTokenMs(
  metadata: PageWiseMessageMetadata,
): number | undefined {
  if (metadata.startedAt == null || metadata.firstTokenAt == null) return undefined;
  return Math.max(0, metadata.firstTokenAt - metadata.startedAt);
}

/** Output tokens per second after the first token (excludes queue/TTFT). */
export function computeGenerationSpeed(
  metadata: PageWiseMessageMetadata,
  nowMs = Date.now(),
): number | undefined {
  const { outputTokens, startedAt, firstTokenAt, finishedAt } = metadata;
  if (outputTokens == null || outputTokens <= 0 || startedAt == null) return undefined;
  const end = finishedAt ?? nowMs;
  const genStart = firstTokenAt ?? startedAt;
  const genMs = end - genStart;
  if (genMs <= 0) return undefined;
  return outputTokens / (genMs / 1000);
}

export function formatGenerationSpeed(tps: number | undefined): string {
  if (tps == null || !Number.isFinite(tps) || tps <= 0) return "—";
  return `${tps.toFixed(1)} T/s`;
}

export function formatCompactTokenCount(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  if (rounded < 1000) return rounded.toLocaleString();
  if (rounded < 10_000) return `${(rounded / 1000).toFixed(1)}k`;
  return `${Math.round(rounded / 1000)}k`;
}

function sumStepTokens(steps: StepUsageEntry[]): { input: number; output: number } {
  return steps.reduce(
    (acc, step) => ({
      input: acc.input + (step.inputTokens ?? 0),
      output: acc.output + (step.outputTokens ?? 0),
    }),
    { input: 0, output: 0 },
  );
}

/** Agent-only tokens when index OCR usage is tracked separately. */
export function resolveAgentTokenTotals(metadata: PageWiseMessageMetadata | undefined): {
  input?: number;
  output?: number;
} {
  if (!metadata) return {};
  const input =
    metadata.inputTokens != null && metadata.indexInputTokens != null
      ? Math.max(0, metadata.inputTokens - metadata.indexInputTokens)
      : metadata.inputTokens;
  const output =
    metadata.outputTokens != null && metadata.indexOutputTokens != null
      ? Math.max(0, metadata.outputTokens - metadata.indexOutputTokens)
      : metadata.outputTokens;
  return { input, output };
}

export function formatUsageSummaryLine(
  metadata: PageWiseMessageMetadata | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  if (!metadata) return null;

  const steps = metadata.stepUsage ?? [];
  const fromSteps = steps.length > 0 ? sumStepTokens(steps) : null;
  const agent = resolveAgentTokenTotals(metadata);
  const input = fromSteps?.input || agent.input;
  const output = fromSteps?.output || agent.output;

  if (input == null && output == null) return null;

  const inputLabel = formatCompactTokenCount(input);
  const outputLabel = formatCompactTokenCount(output);

  if (steps.length > 1) {
    return t("agent.usageSummaryWithSteps", {
      input: inputLabel,
      output: outputLabel,
      steps: steps.length,
    });
  }

  return t("agent.usageSummary", { input: inputLabel, output: outputLabel });
}

type StepEndEvent = {
  stepNumber: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  toolCalls?: Array<{ toolName: string }>;
};

/** Build a usage metadata callback for `toUIMessageStream`. */
export function createUsageMetadataTracker(model: string): {
  reset: () => void;
  onStepEnd: (event: StepEndEvent) => void;
  messageMetadata: (options: {
    part: {
      type: string;
      totalUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      usage?: { inputTokens?: number; outputTokens?: number };
    };
  }) => PageWiseMessageMetadata | undefined;
} {
  let firstTokenAt: number | undefined;
  const stepUsage: StepUsageEntry[] = [];
  // Number of `finish-step` chunks seen so far; the Nth chunk (0-based) is the
  // downstream signal for real step index N. `onStepEnd` fires BEFORE the
  // matching `finish-step` chunk, so both populate the SAME entry — we upsert
  // by real step index to keep exactly one entry per step (no double counting).
  let finishedSteps = 0;

  const upsertStepEntry = (
    step: number,
    usage: { inputTokens?: number; outputTokens?: number } | undefined,
    toolNames: string[] | undefined,
  ): void => {
    const entry = stepUsage.find((s) => s.step === step);
    if (entry) {
      if (usage?.inputTokens != null) entry.inputTokens = usage.inputTokens;
      if (usage?.outputTokens != null) entry.outputTokens = usage.outputTokens;
      if (toolNames && toolNames.length > 0) entry.toolNames = toolNames;
      return;
    }
    stepUsage.push({
      step,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      ...(toolNames && toolNames.length > 0 ? { toolNames } : {}),
    });
  };

  return {
    reset: () => {
      firstTokenAt = undefined;
      stepUsage.length = 0;
      finishedSteps = 0;
      resetIndexUsageTracker();
    },
    onStepEnd: (event) => {
      const toolNames = event.toolCalls
        ?.map((call) => call.toolName)
        .filter((name): name is string => Boolean(name));
      upsertStepEntry(event.stepNumber, event.usage, toolNames);
    },
    messageMetadata: ({ part }) => {
      if (part.type === "start") {
        firstTokenAt = undefined;
        return { startedAt: Date.now(), model };
      }

      if (
        (part.type === "text-delta" || part.type === "reasoning-delta") &&
        firstTokenAt === undefined
      ) {
        firstTokenAt = Date.now();
        return { firstTokenAt };
      }

      if (part.type === "finish-step") {
        // Each `finish-step` chunk maps to the next real step index; upsert so
        // it dedupes against the `onStepEnd` entry for the same step instead of
        // blindly appending (which double-counted tokens and step count).
        const step = finishedSteps;
        finishedSteps += 1;
        upsertStepEntry(step, part.usage, undefined);
        const totals = sumStepTokens(stepUsage);
        return {
          includesToolContext: true,
          inputTokens: totals.input,
          outputTokens: totals.output,
          stepUsage: [...stepUsage],
        };
      }

      if (part.type === "finish") {
        const usage = part.totalUsage;
        const index = getIndexUsageSnapshot();
        const agentIn = usage?.inputTokens ?? 0;
        const agentOut = usage?.outputTokens ?? 0;
        const lastStep = stepUsage[stepUsage.length - 1];
        const providerMetadata =
          "providerMetadata" in part && part.providerMetadata
            ? (part.providerMetadata as Record<string, unknown>)
            : undefined;
        return {
          finishedAt: Date.now(),
          ...(firstTokenAt !== undefined ? { firstTokenAt } : {}),
          inputTokens: agentIn + index.inputTokens,
          outputTokens: agentOut + index.outputTokens,
          totalTokens:
            (usage?.totalTokens ?? agentIn + agentOut) + index.inputTokens + index.outputTokens,
          indexInputTokens: index.inputTokens,
          indexOutputTokens: index.outputTokens,
          includesToolContext: true,
          ...(providerMetadata ? { providerMetadata } : {}),
          ...(lastStep?.toolNames?.length ? { finalStepTools: [...lastStep.toolNames] } : {}),
          ...(stepUsage.length > 0 ? { stepUsage: [...stepUsage] } : {}),
        };
      }

      return undefined;
    },
  };
}
