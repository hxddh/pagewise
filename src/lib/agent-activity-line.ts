import type { UIMessage } from "ai";
import { getInFlightAssistantMessage } from "./messages-utils";
import { getPageWiseMetadata, type PageWiseUIMessage } from "./message-metadata";
import { getLastAgentMessageContext } from "./agent-view-context";
import { resolveMaxAgentSteps } from "./agent-run-plan";

function resolveUserTextForSteps(messages: UIMessage[]): string {
  const fromContext = getLastAgentMessageContext()?.userText?.trim();
  if (fromContext) return fromContext;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    for (const part of message.parts) {
      if (part.type === "text" && part.text?.trim()) return part.text;
    }
  }
  return "";
}

export function formatElapsedSeconds(startedAt: number | undefined, nowMs: number): number | null {
  if (startedAt == null) return null;
  return Math.max(0, Math.floor((nowMs - startedAt) / 1000));
}

/** Unified activity line: optional step index, elapsed seconds, and action label. */
export function formatAgentActivityLine(options: {
  messages: UIMessage[];
  busy: boolean;
  activity: string | null;
  nowMs: number;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): string | null {
  const { messages, busy, activity, nowMs, t } = options;
  if (!busy) return null;

  const label = activity?.trim() || t("agent.thinking");
  const inFlight = getInFlightAssistantMessage(messages, busy) as PageWiseUIMessage | undefined;
  const meta = inFlight ? getPageWiseMetadata(inFlight) : undefined;
  const startedAt = meta?.startedAt;
  const elapsed = formatElapsedSeconds(startedAt, nowMs);

  const completedSteps = meta?.stepUsage?.length ?? 0;
  const userText = resolveUserTextForSteps(messages);
  const maxSteps = resolveMaxAgentSteps(userText);
  const stepIndex = Math.min(completedSteps + 1, maxSteps);

  let line = t("agent.stepProgress", { step: stepIndex, max: maxSteps, action: label });
  if (elapsed != null) {
    line = `${line} · ${t("agent.elapsedSeconds", { seconds: elapsed })}`;
  }

  if (import.meta.env.DEV && meta?.firstTokenAt != null && startedAt != null) {
    const ttft = Math.max(0, meta.firstTokenAt - startedAt);
    line = `${line} · TTFT ${ttft}ms`;
  }

  return line;
}
