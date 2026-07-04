import { ChevronLeft, MessageSquare } from "lucide-react";
import { useI18n } from "../i18n";

interface AgentDockProps {
  onExpand: () => void;
  busy?: boolean;
  messageCount?: number;
}

export function AgentDock({ onExpand, busy, messageCount = 0 }: AgentDockProps) {
  const { t } = useI18n();
  const badgeLabel =
    messageCount > 0 ? t("agent.messageCount", { count: messageCount }) : undefined;

  return (
    <button
      type="button"
      className="agent-dock"
      onClick={onExpand}
      aria-label={badgeLabel ? `${t("agent.showPanel")} · ${badgeLabel}` : t("agent.showPanel")}
      title={t("agent.showPanel")}
    >
      <div className="agent-dock-icon">
        <MessageSquare size={16} strokeWidth={1.75} />
        {busy && <span className="agent-dock-pulse" aria-hidden />}
      </div>
      {messageCount > 0 && (
        <span className="agent-dock-badge" aria-hidden>
          {messageCount > 99 ? "99+" : messageCount}
        </span>
      )}
      <span className="agent-dock-label">{t("agent.titleShort")}</span>
      <span className="agent-dock-expand" aria-hidden>
        <ChevronLeft size={14} />
      </span>
    </button>
  );
}
