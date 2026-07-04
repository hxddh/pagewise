import { useState } from "react";
import { useI18n } from "../i18n";
import type { StoredChatSession } from "../lib/chat-sessions";
import type { RecentFile } from "../lib/recent-files";
import type { UIMessage } from "ai";

interface DocumentLibraryProps {
  recentFiles: RecentFile[];
  sessions: StoredChatSession[];
  activePath: string | null;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
  onOpenSession: (path: string, sessionId?: string) => void;
  onClearSession: (path: string) => void;
}

function userPreview(messages: UIMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  const text = lastUser.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
  if (!text) return "";
  return text.length > 40 ? `${text.slice(0, 40).trim()}…` : text;
}

export function DocumentLibrary({
  recentFiles,
  sessions,
  activePath,
  onOpenRecent,
  onRemoveRecent,
  onOpenSession,
  onClearSession,
}: DocumentLibraryProps) {
  const { t } = useI18n();
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const recentPaths = new Set(recentFiles.map((f) => f.path));
  const historySessions = sessions
    .filter((s) => s.messages.length > 0 && !recentPaths.has(s.docPath))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12);

  return (
    <div className="document-library">
      <section className="library-section">
        <h3 className="library-section-label">{t("sidebar.recent")}</h3>
        <ul className="library-list">
          {recentFiles.length === 0 ? (
            <li className="library-empty">{t("library.emptyRecentHint")}</li>
          ) : (
            recentFiles.slice(0, 8).map((file) => (
              <li key={file.path} className={file.path === activePath ? "active" : ""}>
                <button
                  type="button"
                  className="library-item"
                  onClick={() => onOpenRecent(file.path)}
                >
                  <span className="library-name">{file.name}</span>
                </button>
                <button
                  type="button"
                  className="library-remove"
                  onClick={() => onRemoveRecent(file.path)}
                  aria-label={t("library.remove")}
                >
                  ×
                </button>
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="library-section">
        <h3 className="library-section-label">{t("sidebar.history")}</h3>
        <ul className="library-list">
          {historySessions.length === 0 ? (
            <li className="library-empty">{t("library.emptySessionsHint")}</li>
          ) : (
            historySessions.map((s) => {
              const preview = userPreview(s.messages);
              const key = `${s.docPath}-${s.sessionId}`;
              const confirming = pendingDelete === key;
              return (
                <li
                  key={key}
                  className={s.docPath === activePath ? "active" : ""}
                >
                  <button
                    type="button"
                    className="library-item library-item-history"
                    onClick={() => onOpenSession(s.docPath, s.sessionId)}
                  >
                    <span className="library-name">{s.docName}</span>
                    {preview ? (
                      <span className="library-preview">{preview}</span>
                    ) : (
                      <span className="library-meta">{formatRelative(s.updatedAt, t)}</span>
                    )}
                  </button>
                  {confirming ? (
                    <span
                      className="library-delete-confirm"
                      role="group"
                      aria-label={t("library.deleteChatConfirm")}
                    >
                      <button
                        type="button"
                        className="library-confirm-yes"
                        onClick={() => {
                          onClearSession(s.docPath);
                          setPendingDelete(null);
                        }}
                        aria-label={t("library.deleteChatConfirmAction")}
                        title={t("library.deleteChatConfirm")}
                      >
                        {t("library.deleteChatConfirmAction")}
                      </button>
                      <button
                        type="button"
                        className="library-confirm-no"
                        onClick={() => setPendingDelete(null)}
                        aria-label={t("common.cancel")}
                      >
                        {t("common.cancel")}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="library-remove"
                      onClick={() => setPendingDelete(key)}
                      aria-label={t("library.deleteChat")}
                    >
                      ×
                    </button>
                  )}
                </li>
              );
            })
          )}
        </ul>
      </section>
    </div>
  );
}

function formatRelative(
  ts: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("library.justNow");
  if (mins < 60) return t("library.minutesAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("library.hoursAgo", { n: hours });
  return t("library.daysAgo", { n: Math.floor(hours / 24) });
}
