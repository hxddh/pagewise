export interface AgentProgressPayload {
  /** English fallback text (used when no i18n key is present). */
  message: string;
  phase?: "tool" | "index" | "search" | "read";
  /** i18n key so the UI renders the progress line in the user's locale. */
  key?: string;
  params?: Record<string, string | number>;
}

type ProgressListener = (payload: AgentProgressPayload) => void;

const listeners = new Set<ProgressListener>();
let latest: AgentProgressPayload | null = null;

export function emitAgentProgress(
  message: string,
  phase?: AgentProgressPayload["phase"],
  i18n?: { key: string; params?: Record<string, string | number> },
): void {
  const payload: AgentProgressPayload = {
    message,
    phase,
    ...(i18n ? { key: i18n.key, params: i18n.params } : {}),
  };
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
