import { getVersion } from "@tauri-apps/api/app";
import pkg from "../../package.json";
import { isTauriRuntime } from "./runtime";

/** Build-time fallback (Vite dev / browser preview). */
export const APP_VERSION_FALLBACK = pkg.version;

/** Runtime bundle version in Tauri; build-time fallback elsewhere. */
export async function resolveAppVersion(): Promise<string> {
  if (!isTauriRuntime()) return APP_VERSION_FALLBACK;
  try {
    return await getVersion();
  } catch {
    return APP_VERSION_FALLBACK;
  }
}
