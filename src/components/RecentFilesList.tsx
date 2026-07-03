import type { RecentFile } from "../lib/recent-files";

interface RecentFilesListProps {
  files: RecentFile[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
}

export function RecentFilesList({
  files,
  activePath,
  onOpen,
  onRemove,
}: RecentFilesListProps) {
  if (files.length === 0) return null;

  return (
    <div className="recent-files">
      <h3>Recent</h3>
      <ul>
        {files.map((f) => (
          <li key={f.path} className={f.path === activePath ? "active" : ""}>
            <button type="button" className="recent-item" onClick={() => onOpen(f.path)}>
              <span className="recent-name" title={f.path}>
                {f.name}
              </span>
              <span className="recent-kind">{f.kind === "pdf" ? "PDF" : "Image"}</span>
            </button>
            <button
              type="button"
              className="recent-remove"
              onClick={() => onRemove(f.path)}
              aria-label={`Remove ${f.name} from recent`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
