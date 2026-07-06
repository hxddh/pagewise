import type { UIMessage } from "ai";
import type { LoadProgress } from "../lib/load-progress";
import type { LoadedDocument } from "../lib/types";

export type AppPhase = "empty" | "loading" | "switching" | "ready";

export interface SessionSnapshot {
  epoch: number;
  phase: AppPhase;
  document: LoadedDocument | null;
  previewPage: number;
  messages: UIMessage[];
  fileError: string | null;
  loading: boolean;
  progress: LoadProgress | null;
  agentOpen: boolean;
}
