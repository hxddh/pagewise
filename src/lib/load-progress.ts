export type LoadStage = "opening" | "extracting" | "ocr" | "indexing" | "done";

export interface LoadProgress {
  stage: LoadStage;
  message: string;
  percent: number;
}

export type LoadProgressCallback = (progress: LoadProgress) => void;

export function report(cb: LoadProgressCallback | undefined, progress: LoadProgress) {
  cb?.(progress);
}
