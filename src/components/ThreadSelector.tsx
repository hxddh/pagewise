import { useI18n } from "../i18n";
import type { ChatThread } from "../lib/chat-sessions";

interface ThreadSelectorProps {
  threads: ChatThread[];
  activeId: string;
  busy?: boolean;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
}

export function ThreadSelector({
  threads,
  activeId,
  busy = false,
  onSelect,
  onNew,
}: ThreadSelectorProps) {
  const { t } = useI18n();

  return (
    <div className="session-selector compact">
      {threads.length > 0 && (
        <select
          className="session-select"
          value={activeId}
          disabled={busy}
          onChange={(e) => onSelect(e.target.value)}
          aria-label={t("session.label")}
        >
          {threads.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className="session-new-btn"
        onClick={onNew}
        disabled={busy}
      >
        {t("session.newChat")}
      </button>
    </div>
  );
}
