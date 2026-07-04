import type { UIMessage } from "ai";
import { isToolUIPart } from "ai";
import { Markdown } from "./Markdown";

interface MessageContentProps {
  message: UIMessage;
  markdown?: boolean;
}

export function MessageContent({ message, markdown = false }: MessageContentProps) {
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

        if (isToolUIPart(part)) return null;

        if (part.type === "reasoning") return null;

        return null;
      })}
    </div>
  );
}
