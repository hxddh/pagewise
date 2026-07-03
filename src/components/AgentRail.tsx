interface AgentRailProps {
  onExpand: () => void;
  hasActivity?: boolean;
}

export function AgentRail({ onExpand, hasActivity }: AgentRailProps) {
  return (
    <button
      type="button"
      className="agent-rail"
      onClick={onExpand}
      title="Show agent panel"
      aria-label="Show agent panel"
    >
      <span className="agent-rail-label">Agent</span>
      {hasActivity && <span className="agent-rail-dot" />}
    </button>
  );
}
