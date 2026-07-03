import type { UIMessage } from "ai";
import { getToolName, isToolUIPart } from "ai";
import { friendlyToolLabel, toolStateSummary } from "../lib/tool-labels";
import { extractExcerpt } from "../lib/citations";
import { CitationBlock } from "./CitationBlock";
import { Markdown } from "./Markdown";

interface MessageContentProps {
  message: UIMessage;
  docName?: string;
  markdown?: boolean;
  onPageFocus?: (page: number) => void;
}

function formatValue(value: unknown, max = 500): string {
  if (value === undefined || value === null) return "";
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function ToolFold({
  toolName,
  state,
  input,
  output,
  errorText,
  docName,
  onPageFocus,
}: {
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  docName?: string;
  onPageFocus?: (page: number) => void;
}) {
  const running = state === "input-streaming" || state === "input-available";
  const label = friendlyToolLabel(toolName, input);
  const inputObj =
    input && typeof input === "object" ? (input as Record<string, unknown>) : null;

  const showCitation =
    state === "output-available" &&
    (toolName === "read_pdf_page" || toolName === "read_pdf_range");
  const page = typeof inputObj?.page === "number" ? inputObj.page : null;
  const start = typeof inputObj?.start === "number" ? inputObj.start : null;
  const end = typeof inputObj?.end === "number" ? inputObj.end : null;
  const excerpt = showCitation ? extractExcerpt(output) : "";

  return (
    <div className="tool-fold-wrap">
      <details className="tool-fold" open={running}>
        <summary className="tool-fold-summary">
          <span className={`tool-dot ${running ? "running" : state === "output-error" ? "error" : "done"}`} />
          <span className="tool-fold-label">{label}</span>
          <span className="tool-fold-state">{toolStateSummary(state)}</span>
        </summary>
        {input !== undefined && (
          <div className="tool-debug">
            <span className="tool-label">Input</span>
            <pre>{formatValue(input, 240)}</pre>
          </div>
        )}
        {state === "output-available" && output !== undefined && (
          <div className="tool-debug">
            <span className="tool-label">Output</span>
            <pre>{formatValue(output)}</pre>
          </div>
        )}
        {errorText && (
          <div className="tool-debug error">
            <span className="tool-label">Error</span>
            <pre>{errorText}</pre>
          </div>
        )}
      </details>
      {showCitation && excerpt && (page || start) && (
        <CitationBlock
          docName={docName}
          page={page ?? start!}
          pageEnd={toolName === "read_pdf_range" ? end ?? undefined : undefined}
          excerpt={excerpt}
          onGoToPage={onPageFocus}
        />
      )}
    </div>
  );
}

export function MessageContent({
  message,
  docName,
  markdown = false,
  onPageFocus,
}: MessageContentProps) {
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
          const toolName = getToolName(part);
          const p = part as {
            state: string;
            input?: unknown;
            output?: unknown;
            errorText?: string;
          };
          return (
            <ToolFold
              key={index}
              toolName={toolName}
              state={p.state}
              input={p.input}
              output={p.output}
              errorText={p.errorText}
              docName={docName}
              onPageFocus={onPageFocus}
            />
          );
        }

        if (part.type === "reasoning") {
          return (
            <details key={index} className="reasoning-block">
              <summary>Reasoning</summary>
              <pre>{part.text}</pre>
            </details>
          );
        }

        return null;
      })}
    </div>
  );
}
