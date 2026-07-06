import { useEffect, useRef } from "react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { getLastAgentMessageContext } from "../lib/agent-view-context";
import { getInFlightAssistantMessage } from "../lib/messages-utils";
import { shouldFollowAgentToPage } from "../lib/page-intent";

/** Jump preview to pages the agent reads when follow-agent is enabled. */
export function useFollowAgent(
  enabled: boolean,
  messages: UIMessage[],
  busy: boolean,
  onPageChange: (page: number) => void,
): void {
  const lastKeyRef = useRef("");

  useEffect(() => {
    if (!enabled || !busy) {
      lastKeyRef.current = "";
      return;
    }

    const assistant = getInFlightAssistantMessage(messages, true);
    if (!assistant) return;

    const ctx = getLastAgentMessageContext();
    const followCtx = ctx
      ? { userText: ctx.userText, viewingPage: ctx.viewingPage }
      : null;

    for (let i = assistant.parts.length - 1; i >= 0; i--) {
      const part = assistant.parts[i];
      if (!isToolUIPart(part)) continue;
      if (part.state !== "input-available" && part.state !== "output-available") continue;

      const name = getToolName(part);
      const input =
        part.input && typeof part.input === "object"
          ? (part.input as Record<string, unknown>)
          : {};

      let page: number | undefined;
      if (name === "read_pdf_page" && typeof input.page === "number") {
        page = input.page;
      } else if (name === "read_pdf_range" && typeof input.start === "number") {
        page = input.start;
      } else {
        continue;
      }

      const key = `${assistant.id}:${i}:${page}`;
      if (lastKeyRef.current === key) return;
      if (!shouldFollowAgentToPage(page, followCtx)) return;

      lastKeyRef.current = key;
      onPageChange(page);
      return;
    }
  }, [enabled, messages, busy, onPageChange]);
}
