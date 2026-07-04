/** True when running inside the Tauri desktop shell (not vite dev in a browser tab). */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
