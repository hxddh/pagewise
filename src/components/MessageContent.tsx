import { memo } from "react";
import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";
import { useI18n } from "../i18n";
import {
  segmentMessageParts,
  summarizeToolSteps,
  toolStepFromPart,
} from "../lib/tool-steps-summary";
import { stripDsmlToolMarkup } from "../lib/agent-loop-guards";
import { Markdown } from "./Markdown";

interface MessageContentProps {
  message: UIMessage;
  markdown?: boolean;
  /** True for the in-flight assistant reply — enables live tool progress UI. */
  live?: boolean;
  /** Brief transition after stream ends while history is compacted. */
  settling?: boolean;
}

function partsSignature(parts: UIMessage["parts"] | undefined): string {
  if (!Array.isArray(parts)) return "0:";
  let sig = `${parts.length}:`;
  for (const p of parts) {
    if (p.type === "text") {
      sig += `t${p.text.length}:${p.text.slice(0, 16)}:${p.text.slice(-24)};`;
    } else if (p.type === "reasoning") {
      sig += `r${p.text.length}:${p.text.slice(0, 16)}:${p.text.slice(-24)};`;
    } else if (isToolUIPart(p)) {
      const id = (p as { toolCallId?: string }).toolCallId ?? "";
      sig += `${p.type}:${p.state}:${id};`;
    } else sig += `${p.type};`;
  }
  return sig;
}

function messageParts(message: UIMessage): UIMessage["parts"] {
  if (Array.isArray(message.parts) && message.parts.length > 0) {
    return message.parts;
  }
  const legacy = (message as { content?: unknown }).content;
  if (typeof legacy === "string" && legacy.trim()) {
    return [{ type: "text", text: legacy }];
  }
  return [];
}

function hasAnswerText(parts: UIMessage["parts"]): boolean {
  return parts.some((p) => {
    if (p.type !== "text" && p.type !== "reasoning") return false;
    return !!stripDsmlToolMarkup(p.text ?? "").trim();
  });
}

function ToolStepsBlock({
  parts,
  t,
  live = false,
  settling = false,
}: {
  parts: Array<{ part: Parameters<typeof toolStepFromPart>[0]; index: number }>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  live?: boolean;
  settling?: boolean;
}) {
  const steps = parts.map(({ part }) => toolStepFromPart(part, t));
  const { aggregate, summary, details, anyRunning } = summarizeToolSteps(steps, t);
  const useFold = aggregate || live;

  if (!useFold) {
    return (
      <span className="tool-chip">
        <span className="tool-chip-dot" aria-hidden>
          ·
        </span>
        {summary}
      </span>
    );
  }

  return (
    <div className={`tool-fold-wrap${settling ? " tool-fold-wrap--settling" : ""}`}>
      <details className="tool-fold" open={live && anyRunning}>
        <summary className="tool-fold-summary">
          <span
            className={`tool-dot ${anyRunning ? "running" : "done"}`}
            aria-hidden
          />
          <span className="tool-fold-label">{summary}</span>
        </summary>
        <ul className="tool-steps-list">
          {details.map(({ label, count }, detailIndex) => (
            <li key={`${label}-${detailIndex}`}>
              {count > 1 ? t("agent.toolStepRepeat", { label, count }) : label}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function MessageContentInner({
  message,
  markdown = false,
  live = false,
  settling = false,
}: MessageContentProps) {
  const { t } = useI18n();
  const parts = messageParts(message);
  const showReasoningAsAnswer = message.role === "assistant" && !hasAnswerText(parts);
  const segments = segmentMessageParts(parts);

  let sawAnswerBody = false;

  const body = segments.map((segment, segmentIndex) => {
    if (segment.kind === "tools") {
      return (
        <ToolStepsBlock
          key={`tools-${segmentIndex}`}
          parts={segment.parts}
          t={t}
          live={live}
          settling={settling}
        />
      );
    }

    const { part, index } = segment;

    if (part.type === "text") {
      if (!part.text?.trim() && !live) return null;
      if (!part.text) return null;
      const displayText =
        message.role === "assistant" ? stripDsmlToolMarkup(part.text) : part.text;
      if (!displayText.trim() && !live) return null;
      sawAnswerBody = true;
      return markdown ? (
        <Markdown key={index} live={live}>
          {displayText}
        </Markdown>
      ) : (
        <div key={index} className="message-body">
          {displayText}
        </div>
      );
    }

    if (part.type === "reasoning") {
      if (!part.text?.trim()) return null;
      if (showReasoningAsAnswer) {
        sawAnswerBody = true;
        const displayText = stripDsmlToolMarkup(part.text);
        if (!displayText.trim() && !live) return null;
        return markdown ? (
          <Markdown key={index} live={live}>
            {displayText}
          </Markdown>
        ) : (
          <div key={index} className="message-body">
            {displayText}
          </div>
        );
      }
      return (
        <details key={index} className="reasoning-block" open={live || undefined}>
          <summary>{live ? t("agent.activityThinking") : t("agent.reasoningSummary")}</summary>
          <pre>{part.text}</pre>
        </details>
      );
    }

    return null;
  });

  const showEmptyReply =
    message.role === "assistant" &&
    !sawAnswerBody &&
    !live &&
    parts.some((p) => isToolUIPart(p) && p.state === "output-available");

  return (
    <div className={`message-parts${settling ? " message-parts--settling" : ""}`}>
      {body}
      {showEmptyReply && (
        <p className="message-empty-reply">{t("agent.noReply")}</p>
      )}
    </div>
  );
}

export const MessageContent = memo(
  MessageContentInner,
  (prev, next) => {
    if (prev.live !== next.live) return false;
    if (prev.settling !== next.settling) return false;
    if (prev.markdown !== next.markdown) return false;
    if (prev.message.id !== next.message.id) return false;
    return partsSignature(prev.message.parts) === partsSignature(next.message.parts);
  },
);
