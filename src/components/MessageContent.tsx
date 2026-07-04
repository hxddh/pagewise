import { memo } from "react";
import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";
import { useI18n } from "../i18n";
import { Markdown } from "./Markdown";

interface MessageContentProps {
  message: UIMessage;
  markdown?: boolean;
}

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

function toolChipLabel(toolName: string, input: unknown, t: TranslateFn): string {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "read_pdf_page":
      return typeof args.page === "number"
        ? t("agent.toolReadPage", { page: args.page })
        : t("agent.toolWorking");
    case "read_pdf_range":
      return typeof args.start === "number" && typeof args.end === "number"
        ? t("agent.toolReadRange", { start: args.start, end: args.end })
        : t("agent.toolWorking");
    case "search_in_document":
      return typeof args.query === "string"
        ? t("agent.toolSearch", { query: args.query })
        : t("agent.toolWorking");
    case "get_document_index":
      return t("agent.toolIndex");
    default:
      return t("agent.toolWorking");
  }
}

function partsSignature(parts: UIMessage["parts"]): string {
  let sig = `${parts.length}:`;
  for (const p of parts) {
    if (p.type === "text") sig += `t${p.text.length}:${p.text.slice(-24)};`;
    else if (isToolUIPart(p)) sig += `${p.type}:${p.state};`;
    else sig += `${p.type};`;
  }
  return sig;
}

function MessageContentInner({ message, markdown = false }: MessageContentProps) {
  const { t } = useI18n();

  return (
    <div className="message-parts">
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          if (!part.text) return null;
          return markdown ? (
            <Markdown key={index}>{part.text}</Markdown>
          ) : (
            <div key={index} className="message-body">
              {part.text}
            </div>
          );
        }

        if (isToolUIPart(part)) {
          const toolName = part.type.replace(/^tool-/, "");
          const label = toolChipLabel(toolName, part.input, t);
          return (
            <span key={index} className="tool-chip">
              <span className="tool-chip-dot" aria-hidden>
                ·
              </span>
              {label}
            </span>
          );
        }

        if (part.type === "reasoning") return null;

        return null;
      })}
    </div>
  );
}

export const MessageContent = memo(
  MessageContentInner,
  (prev, next) =>
    prev.markdown === next.markdown &&
    prev.message.id === next.message.id &&
    partsSignature(prev.message.parts) === partsSignature(next.message.parts),
);
