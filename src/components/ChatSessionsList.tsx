import type { StoredChatSession } from "../lib/chat-sessions";

interface ChatSessionsListProps {
  sessions: StoredChatSession[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onClear: (path: string) => void;
}

export function ChatSessionsList({
  sessions,
  activePath,
  onOpen,
  onClear,
}: ChatSessionsListProps) {
  if (sessions.length === 0) return null;

  return (
    <div className="chat-sessions">
      <h3>Saved chats</h3>
      <ul>
        {sessions.map((s) => (
          <li key={s.docPath} className={s.docPath === activePath ? "active" : ""}>
            <button type="button" className="session-item" onClick={() => onOpen(s.docPath)}>
              <span className="session-name">{s.docName}</span>
              <span className="session-meta">
                {s.messages.length} msg · {formatRelative(s.updatedAt)}
              </span>
            </button>
            <button
              type="button"
              className="recent-remove"
              onClick={() => onClear(s.docPath)}
              aria-label="Delete saved chat"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
