import type { LanguageModel } from "ai";
import { pruneMessages, type ModelMessage } from "ai";
import { compactStaleToolResults } from "./compact-agent-messages";
import { emitAgentProgress } from "./agent-progress";
import { resolveModel } from "./llm";
import { pickFastModelId, resolveFastModel, shouldUseFastModelForStep } from "./model-routing";
import type { LlmSettings } from "./types";

const READ_TOOLS = ["read_pdf_page", "read_pdf_range"] as const;
const LIGHT_TOOLS = ["search_in_document", "get_document_index", "list_documents"] as const;

/** Rough token estimate: JSON char length / 4 (SDK docs pattern). */
export const ESTIMATED_CHARS_PER_TOKEN = 4;

export const COMPACT_NORMAL_ESTIMATED_TOKENS = 18_000;
export const COMPACT_AGGRESSIVE_ESTIMATED_TOKENS = 28_000;
export const COMPACT_AGGRESSIVE_STEP_INPUT_TOKENS = 24_000;

export type CompactionLevel = "none" | "normal" | "aggressive";

type AgentStep = {
  toolCalls?: unknown[];
  text?: string;
  usage?: { inputTokens?: number };
};

export function estimateMessageTokens(messages: ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / ESTIMATED_CHARS_PER_TOKEN);
}

export function sumStepInputTokens(steps: AgentStep[]): number {
  return steps.reduce((sum, step) => sum + (step.usage?.inputTokens ?? 0), 0);
}

export function hasBudgetExceededInMessages(messages: ModelMessage[]): boolean {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const output = part.output;
      if (output && typeof output === "object" && !Array.isArray(output)) {
        if ((output as Record<string, unknown>).budgetExceeded === true) return true;
      }
    }
  }
  return false;
}

export function resolveCompactionLevel(
  messages: ModelMessage[],
  steps: AgentStep[],
  stepNumber: number,
): CompactionLevel {
  const estimated = estimateMessageTokens(messages);
  const stepInput = sumStepInputTokens(steps);
  const lastStepInput = steps[steps.length - 1]?.usage?.inputTokens ?? 0;

  if (
    estimated >= COMPACT_AGGRESSIVE_ESTIMATED_TOKENS ||
    stepInput >= COMPACT_AGGRESSIVE_STEP_INPUT_TOKENS ||
    lastStepInput >= COMPACT_AGGRESSIVE_ESTIMATED_TOKENS
  ) {
    return "aggressive";
  }

  if (stepNumber > 0 || messages.length > 2 || estimated >= COMPACT_NORMAL_ESTIMATED_TOKENS) {
    return "normal";
  }

  return "none";
}

export function compactAgentMessages(
  messages: ModelMessage[],
  level: CompactionLevel,
  thinkingEnabled: boolean,
  stepNumber: number,
): ModelMessage[] {
  if (level === "none") return messages;

  const reasoning =
    thinkingEnabled && (level === "aggressive" || stepNumber > 0)
      ? "all"
      : "before-last-message";

  const toolCalls =
    level === "aggressive"
      ? [
          {
            type: "before-last-1-messages" as const,
            tools: [...READ_TOOLS, ...LIGHT_TOOLS],
          },
        ]
      : [
          { type: "before-last-2-messages" as const, tools: [...READ_TOOLS] },
          { type: "before-last-2-messages" as const, tools: [...LIGHT_TOOLS] },
        ];

  let pruned = pruneMessages({
    messages,
    reasoning,
    toolCalls,
    emptyMessages: "remove",
  });

  pruned = compactStaleToolResults(pruned, 1);
  return pruned;
}

/** Last step ran tools but produced no answer text — candidate for a synthesis-only step. */
export function isPostToolStep(steps: AgentStep[]): boolean {
  const last = steps[steps.length - 1];
  if (!last) return false;
  return (last.toolCalls?.length ?? 0) > 0 && !last.text?.trim();
}

export function shouldForceSynthesisStep(
  steps: AgentStep[],
  messages: ModelMessage[],
  compactionLevel: CompactionLevel,
  budgetUsed: number,
  budgetMax: number,
): boolean {
  if (!isPostToolStep(steps)) return false;
  if (hasBudgetExceededInMessages(messages)) return true;
  if (budgetMax > 0 && budgetUsed >= budgetMax * 0.85) return true;
  if (compactionLevel === "aggressive") return true;
  return false;
}

export interface PrepareStepContext {
  settings: LlmSettings;
  stepNumber: number;
  steps: AgentStep[];
  messages: ModelMessage[];
  budgetUsed: number;
  budgetMax: number;
}

export interface PrepareStepOverrides {
  model: LanguageModel;
  messages: ModelMessage[];
  activeTools?: [];
  toolChoice?: "none";
}

export function buildPrepareStepOverrides(ctx: PrepareStepContext): PrepareStepOverrides {
  const { settings, stepNumber, steps, messages, budgetUsed, budgetMax } = ctx;
  const compactionLevel = resolveCompactionLevel(messages, steps, stepNumber);
  const prunedMessages = compactAgentMessages(
    messages,
    compactionLevel,
    settings.thinkingEnabled ?? false,
    stepNumber,
  );

  const baseModel = resolveModel(settings);

  if (shouldForceSynthesisStep(steps, messages, compactionLevel, budgetUsed, budgetMax)) {
    emitAgentProgress("Synthesizing answer from gathered context…", "tool");
    return {
      model: baseModel,
      messages: prunedMessages,
      activeTools: [],
      toolChoice: "none",
    };
  }

  if (shouldUseFastModelForStep(stepNumber, steps)) {
    const fast = resolveFastModel(settings);
    if (fast) {
      const fastId = pickFastModelId(settings);
      if (fastId) {
        emitAgentProgress(`Routing step ${stepNumber + 1} to ${fastId}…`, "tool");
      }
      return { model: fast, messages: prunedMessages };
    }
  }

  return { model: baseModel, messages: prunedMessages };
}
