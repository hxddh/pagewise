import type { ModelMessage } from "ai";
import { hasWholeDocumentIntent, isTargetedFactualQuery } from "./page-intent";
import {
  countToolCalls,
  hasReadToolInSteps,
  type AgentStepSnapshot,
} from "./agent-loop-guards";

export const MAX_AGENT_STEPS_FULL = 14;
export const MAX_AGENT_STEPS_TARGETED = 6;

/** Extract plain text from the most recent user turn in model messages. */
export function extractLastUserTextFromMessages(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const parts: string[] = [];
      for (const part of message.content) {
        if (part.type === "text" && part.text) parts.push(part.text);
      }
      return parts.join("\n");
    }
  }
  return "";
}

export function resolveMaxAgentSteps(userText: string): number {
  if (hasWholeDocumentIntent(userText)) return MAX_AGENT_STEPS_FULL;
  if (isTargetedFactualQuery(userText)) return MAX_AGENT_STEPS_TARGETED;
  return MAX_AGENT_STEPS_FULL;
}

/** After tools gathered context, move to synthesis instead of another tool round. */
export function shouldSynthesizeAfterTools(steps: AgentStepSnapshot[]): boolean {
  const last = steps[steps.length - 1];
  if (!last) return false;
  if (!(last.toolCalls?.length ?? 0)) return false;
  const answer = last.text?.trim();
  if (answer) return false;

  if (hasReadToolInSteps(steps)) return true;
  if (countToolCalls(steps, "search_in_document") >= 1 && steps.length >= 2) return true;
  return false;
}

/** Reserve the last step for a guaranteed text answer (fallback only near the cap). */
export function shouldReserveFinalSynthesis(
  stepNumber: number,
  maxSteps: number,
): boolean {
  return maxSteps > 0 && stepNumber >= maxSteps - 1;
}
