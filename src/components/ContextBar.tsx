import type { LoadedDocument } from "../lib/types";

interface ContextBarProps {
  doc: LoadedDocument | null;
  previewPage: number;
  followAgent: boolean;
  onFollowAgentChange: (value: boolean) => void;
  activity: string | null;
}

export function ContextBar({
  doc,
  previewPage,
  followAgent,
  onFollowAgentChange,
  activity,
}: ContextBarProps) {
  if (!doc) return null;

  const pageLabel =
    doc.kind === "pdf"
      ? `Page ${previewPage} of ${doc.totalPages}`
      : "Image";

  const hasText =
    doc.kind === "pdf"
      ? (doc.pages[previewPage - 1]?.text.trim().length ?? 0) > 0
      : true;

  return (
    <div className="context-bar">
      <div className="context-info">
        <span className="context-doc" title={doc.name}>
          {doc.name}
        </span>
        <span className="context-sep">·</span>
        <span className="context-page">{pageLabel}</span>
        <span className="context-sep">·</span>
        <span className="context-layer">
          {doc.kind === "image" ? "OCR" : hasText ? "Text layer" : "Scan"}
        </span>
      </div>
      <label className="context-toggle">
        <input
          type="checkbox"
          checked={followAgent}
          onChange={(e) => onFollowAgentChange(e.target.checked)}
        />
        Follow agent
      </label>
      {activity && <span className="context-activity">{activity}</span>}
    </div>
  );
}
