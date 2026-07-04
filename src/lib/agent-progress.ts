export interface AgentProgressPayload {
  message: string;
  phase?: "tool" | "index" | "search" | "read";
}

type ProgressListener = (payload: AgentProgressPayload) => void;

const listeners = new Set<ProgressListener>();
let latest: AgentProgressPayload | null = null;

export function emitAgentProgress(
  message: string,
  phase?: AgentProgressPayload["phase"],
): void {
  const payload = { message, phase };
  latest = payload;
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch {
      /* ignore */
    }
  }
}

export function subscribeAgentProgress(listener: ProgressListener): () => void {
  listeners.add(listener);
  if (latest) listener(latest);
  return () => listeners.delete(listener);
}

export function clearAgentProgress(): void {
  latest = null;
}

export function getLatestAgentProgress(): AgentProgressPayload | null {
  return latest;
}
