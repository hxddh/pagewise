import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "./types";

export async function getApiKey(provider: ProviderId): Promise<string> {
  return invoke<string>("get_api_key", { provider });
}

export async function setApiKey(provider: ProviderId, key: string): Promise<void> {
  await invoke("set_api_key", { provider, key });
}

export async function deleteApiKey(provider: ProviderId): Promise<void> {
  await invoke("delete_api_key", { provider });
}
