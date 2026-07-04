import type { LanguageModel } from "ai";
import { pruneMessages, type ModelMessage } from "ai";
import { compactStaleToolResults } from "./compact-agent-messages";
import { emitAgentProgress } from "./agent-progress";
import {
  AGENT_TOOL_NAMES,
  getBlockedMetaTools,
  isDsmlOnlyAssistantText,
  isMetaToolOnlyLoop,
  READ_TOOL_NAMES,
  shouldForceReadTools,
  type AgentStepSnapshot,
  type AgentToolName,
} from "./agent-loop-guards";
import { resolveModel } from "./llm";
import { pickFastModelId, resolveFastModel, shouldUseFastModelForStep } from "./model-routing";
import {
  extractLastUserTextFromMessages,
  resolveMaxAgentSteps,
  shouldReserveFinalSynthesis,
  shouldSynthesizeAfterTools,
} from "./agent-run-plan";
import type { LlmSettings } from "./types";

const READ_TOOLS = ["read_pdf_page", "read_pdf_range"] as const;
const LIGHT_TOOLS = ["search_in_document", "get_document_index", "list_documents"] as const;

/** Rough token estimate: JSON char length / 4 (SDK docs pattern). */
export const ESTIMATED_CHARS_PER_TOKEN = 4;

export const COMPACT_NORMAL_ESTIMATED_TOKENS = 18_000;
export const COMPACT_AGGRESSIVE_ESTIMATED_TOKENS = 28_000;
export const COMPACT_AGGRESSIVE_STEP_INPUT_TOKENS = 20_000;

export type CompactionLevel = "none" | "normal" | "aggressive";

type AgentStep = AgentStepSnapshot & {
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
  // Use the LIVE context size — the serialized messages we are about to send,
  // plus the provider-reported input of the last step (a single step's input,
  // which reflects the real context the model saw). Do NOT sum inputTokens
  // across steps: every step re-sends the growing context, so a cumulative sum
  // re-counts the same tokens and trips the aggressive threshold far too early.
  const lastStepInput = steps[steps.length - 1]?.usage?.inputTokens ?? 0;

  if (
    estimated >= COMPACT_AGGRESSIVE_ESTIMATED_TOKENS ||
    lastStepInput >= COMPACT_AGGRESSIVE_STEP_INPUT_TOKENS
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
  const text = last.text?.trim();
  if (text && isDsmlOnlyAssistantText(text)) return true;
  return (last.toolCalls?.length ?? 0) > 0 && !text;
}

export function shouldForceSynthesisStep(
  steps: AgentStep[],
  messages: ModelMessage[],
  _compactionLevel: CompactionLevel,
  budgetUsed: number,
  budgetMax: number,
): boolean {
  if (!isPostToolStep(steps)) return false;
  if (hasBudgetExceededInMessages(messages)) return true;
  if (budgetMax > 0 && budgetUsed >= budgetMax * 0.85) return true;
  // NOTE: `_compactionLevel === "aggressive"` does NOT force synthesis here.
  // Aggressive mode prunes older read/light results down to the last message,
  // so forcing `toolChoice:"none"` on the very same step would make the model
  // synthesize a whole-document answer from only the last chunk. Instead we let
  // it gather at least one more step; a dead-end tool step is prevented by the
  // reserved final synthesis step (see `shouldReserveFinalSynthesis`).
  return false;
}

export { shouldReserveFinalSynthesis } from "./agent-run-plan";

export interface PrepareStepContext {
  settings: LlmSettings;
  stepNumber: number;
  steps: AgentStep[];
  messages: ModelMessage[];
  budgetUsed: number;
  budgetMax: number;
  /** Hard step cap for the run; the last step is reserved for synthesis. */
  maxSteps: number;
}

export interface PrepareStepOverrides {
  model: LanguageModel;
  messages: ModelMessage[];
  activeTools?: readonly AgentToolName[];
  toolChoice?: "none" | "required" | "auto";
}

export function buildPrepareStepOverrides(ctx: PrepareStepContext): PrepareStepOverrides {
  const { settings, stepNumber, steps, messages, budgetUsed, budgetMax, maxSteps } = ctx;
  const userText = extractLastUserTextFromMessages(messages);
  const effectiveMaxSteps = maxSteps > 0 ? maxSteps : resolveMaxAgentSteps(userText);
  const compactionLevel = resolveCompactionLevel(messages, steps, stepNumber);
  const prunedMessages = compactAgentMessages(
    messages,
    compactionLevel,
    settings.thinkingEnabled ?? false,
    stepNumber,
  );

  const baseModel = resolveModel(settings);

  const lastStep = steps[steps.length - 1];
  if (lastStep && isDsmlOnlyAssistantText(lastStep.text)) {
    emitAgentProgress("Tool call leaked as text — synthesizing answer…", "tool");
    return {
      model: baseModel,
      messages: prunedMessages,
      activeTools: [],
      toolChoice: "none",
    };
  }

  if (isMetaToolOnlyLoop(steps)) {
    emitAgentProgress("Stopping repeated scans — synthesizing answer…", "tool");
    return {
      model: baseModel,
      messages: prunedMessages,
      activeTools: [],
      toolChoice: "none",
    };
  }

  if (shouldSynthesizeAfterTools(steps)) {
    emitAgentProgress("Synthesizing answer from gathered context…", "tool");
    return {
      model: baseModel,
      messages: prunedMessages,
      activeTools: [],
      toolChoice: "none",
    };
  }

  // Reserve the final allowed step for a text answer so a hard cap never ends on tools.
  if (shouldReserveFinalSynthesis(stepNumber, effectiveMaxSteps)) {
    emitAgentProgress("Synthesizing final answer…", "tool");
    return {
      model: baseModel,
      messages: prunedMessages,
      activeTools: [],
      toolChoice: "none",
    };
  }

  if (shouldForceSynthesisStep(steps, messages, compactionLevel, budgetUsed, budgetMax)) {
    emitAgentProgress("Synthesizing answer from gathered context…", "tool");
    return {
      model: baseModel,
      messages: prunedMessages,
      activeTools: [],
      toolChoice: "none",
    };
  }

  if (shouldForceReadTools(steps)) {
    emitAgentProgress("Reading matched pages…", "read");
    // A forced read step is provably intermediate (toolChoice:"required" — the
    // model must emit a read call, not a final answer), so it is safe to route
    // to the cheaper model. The free-choice answer step never gets the fast
    // model, which previously risked sending the user-visible answer to it.
    let model = baseModel;
    if (shouldUseFastModelForStep(stepNumber, steps)) {
      const fast = resolveFastModel(settings);
      if (fast) {
        model = fast;
        const fastId = pickFastModelId(settings);
        if (fastId) {
          emitAgentProgress(`Routing step ${stepNumber + 1} to ${fastId}…`, "tool");
        }
      }
    }
    return {
      model,
      messages: prunedMessages,
      activeTools: [...READ_TOOL_NAMES],
      toolChoice: "required",
    };
  }

  const blocked = getBlockedMetaTools(steps);
  if (blocked.length > 0) {
    return {
      model: baseModel,
      messages: prunedMessages,
      activeTools: AGENT_TOOL_NAMES.filter(
        (name) => !blocked.includes(name),
      ) as AgentToolName[],
    };
  }

  return { model: baseModel, messages: prunedMessages };
}
