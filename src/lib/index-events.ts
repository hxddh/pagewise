export type IndexSource = "vision" | "ocr" | "extract" | "cache";
export type IndexStatus = "indexing" | "done" | "failed" | "idle";

export type IndexFailureReason =
  | "need_vision"
  | "ocr_unavailable"
  | "vision_failed"
  | "insufficient_text"
  | "unknown";

export interface PageIndexState {
  path: string;
  page: number;
  status: IndexStatus;
  source?: IndexSource;
  error?: string;
  failureReason?: IndexFailureReason;
}

type IndexListener = (state: PageIndexState) => void;

const listeners = new Set<IndexListener>();
const states = new Map<string, PageIndexState>();

function key(path: string, page: number): string {
  return `${path}:${page}`;
}

export function getPageIndexState(path: string, page: number): PageIndexState | undefined {
  return states.get(key(path, page));
}

export function clearPageIndexState(path: string, page: number): void {
  states.delete(key(path, page));
  emitPageIndex({ path, page, status: "idle" });
}

/**
 * Drop all cached per-page index states for a document. Call when a document is
 * closed/evicted so the `states` map doesn't grow unbounded across the session.
 */
export function clearDocumentIndexState(path: string): void {
  const prefix = `${path}:`;
  for (const stateKey of [...states.keys()]) {
    if (!stateKey.startsWith(prefix)) continue;
    const page = Number(stateKey.slice(prefix.length));
    states.delete(stateKey);
    emitPageIndex({ path, page, status: "idle" });
  }
}

export function subscribePageIndex(listener: IndexListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitPageIndex(state: PageIndexState): void {
  states.set(key(state.path, state.page), state);
  for (const listener of listeners) {
    try {
      listener(state);
    } catch {
      // A throwing listener must not abort delivery to the remaining listeners.
    }
  }
}
