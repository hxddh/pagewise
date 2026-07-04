export type IndexSource = "vision" | "ocr" | "extract" | "cache";
export type IndexStatus = "indexing" | "done" | "failed";

export type IndexFailureReason =
  | "need_vision"
  | "ocr_unavailable"
  | "vision_failed"
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
}

export function subscribePageIndex(listener: IndexListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitPageIndex(state: PageIndexState): void {
  states.set(key(state.path, state.page), state);
  for (const listener of listeners) listener(state);
}
