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
  /** Structured citations extracted post-reply via generateObject. */
  structuredCitations?: StructuredCitation[];
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
    part: { type: string; totalUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } };
  }) => PageWiseMessageMetadata | undefined;
} {
  let firstTokenAt: number | undefined;
  const stepUsage: StepUsageEntry[] = [];

  return {
    reset: () => {
      firstTokenAt = undefined;
      stepUsage.length = 0;
      resetIndexUsageTracker();
    },
    onStepEnd: (event) => {
      const toolNames = event.toolCalls
        ?.map((call) => call.toolName)
        .filter((name): name is string => Boolean(name));
      stepUsage.push({
        step: event.stepNumber,
        inputTokens: event.usage?.inputTokens,
        outputTokens: event.usage?.outputTokens,
        ...(toolNames && toolNames.length > 0 ? { toolNames } : {}),
      });
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

      if (part.type === "finish") {
        const usage = part.totalUsage;
        const index = getIndexUsageSnapshot();
        const agentIn = usage?.inputTokens ?? 0;
        const agentOut = usage?.outputTokens ?? 0;
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
          ...(stepUsage.length > 0 ? { stepUsage: [...stepUsage] } : {}),
        };
      }

      return undefined;
    },
  };
}
