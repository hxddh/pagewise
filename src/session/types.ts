import type { LoadProgress } from "../lib/load-progress";
import type { LoadedDocument } from "../lib/types";

export type AppPhase = "empty" | "switching" | "ready";

export interface SessionState {
  phase: AppPhase;
  document: LoadedDocument | null;
  previewPage: number;
  fileError: string | null;
  loading: boolean;
  progress: LoadProgress | null;
  agentOpen: boolean;
}
