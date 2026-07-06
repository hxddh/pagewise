export type LoadStage = "opening" | "extracting" | "indexing" | "done";

export interface LoadProgress {
  stage: LoadStage;
  /** i18n message key */
  message: string;
  messageParams?: Record<string, string | number>;
  percent: number;
}

export type LoadProgressCallback = (progress: LoadProgress) => void;

export function report(cb: LoadProgressCallback | undefined, progress: LoadProgress) {
  cb?.(progress);
}
