import { memo } from "react";
import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";
import { useI18n } from "../i18n";
import {
  segmentMessageParts,
  summarizeToolSteps,
  toolStepFromPart,
} from "../lib/tool-steps-summary";
import { Markdown } from "./Markdown";

interface MessageContentProps {
  message: UIMessage;
  markdown?: boolean;
  /** True for the in-flight assistant reply — enables live tool progress UI. */
  live?: boolean;
}

function partsSignature(parts: UIMessage["parts"] | undefined): string {
  if (!Array.isArray(parts)) return "0:";
  let sig = `${parts.length}:`;
  for (const p of parts) {
    if (p.type === "text") sig += `t${p.text.length}:${p.text.slice(-24)};`;
    else if (p.type === "reasoning") sig += `r${p.text.length}:${p.text.slice(-24)};`;
    else if (isToolUIPart(p)) sig += `${p.type}:${p.state};`;
    else sig += `${p.type};`;
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
  return parts.some((p) => p.type === "text" && !!p.text?.trim());
}

function ToolStepsBlock({
  parts,
  t,
  live = false,
}: {
  parts: Array<{ part: Parameters<typeof toolStepFromPart>[0]; index: number }>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  live?: boolean;
}) {
  const steps = parts.map(({ part }) => toolStepFromPart(part, t));
  const { aggregate, summary, details, anyRunning } = summarizeToolSteps(steps, t);
  const useFold = aggregate || (live && anyRunning);

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
    <div className="tool-fold-wrap">
      <details className="tool-fold" open={anyRunning || undefined}>
        <summary className="tool-fold-summary">
          <span
            className={`tool-dot ${anyRunning ? "running" : "done"}`}
            aria-hidden
          />
          <span className="tool-fold-label">{summary}</span>
        </summary>
        <ul className="tool-steps-list">
          {details.map(({ label, count }) => (
            <li key={label}>
              {count > 1 ? t("agent.toolStepRepeat", { label, count }) : label}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function MessageContentInner({ message, markdown = false, live = false }: MessageContentProps) {
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
        />
      );
    }

    const { part, index } = segment;

    if (part.type === "text") {
      if (!part.text?.trim() && !live) return null;
      if (!part.text) return null;
      sawAnswerBody = true;
      return markdown ? (
        <Markdown key={index}>{part.text}</Markdown>
      ) : (
        <div key={index} className="message-body">
          {part.text}
        </div>
      );
    }

    if (part.type === "reasoning") {
      if (!part.text?.trim()) return null;
      if (showReasoningAsAnswer) {
        sawAnswerBody = true;
        return markdown ? (
          <Markdown key={index}>{part.text}</Markdown>
        ) : (
          <div key={index} className="message-body">
            {part.text}
          </div>
        );
      }
      return (
        <details key={index} className="reasoning-block">
          <summary>{t("agent.reasoningSummary")}</summary>
          <pre>{part.text}</pre>
        </details>
      );
    }

    return null;
  });

  const showEmptyReply =
    message.role === "assistant" &&
    !sawAnswerBody &&
    parts.some((p) => isToolUIPart(p) && p.state === "output-available");

  return (
    <div className="message-parts">
      {body}
      {showEmptyReply && (
        <p className="message-empty-reply">{t("agent.noReply")}</p>
      )}
    </div>
  );
}

export const MessageContent = memo(
  MessageContentInner,
  (prev, next) =>
    prev.markdown === next.markdown &&
    prev.live === next.live &&
    prev.message.id === next.message.id &&
    partsSignature(prev.message.parts) === partsSignature(next.message.parts),
);
