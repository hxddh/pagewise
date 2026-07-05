import { createContext, useContext, type ReactNode } from "react";
import type { CommandItem } from "../lib/commands";
import type { SettingsTab } from "../lib/preferences";

export interface ShellContextValue {
  settingsOpen: boolean;
  settingsTab: SettingsTab | undefined;
  setSettingsOpen: (open: boolean) => void;
  setSettingsTab: (tab: SettingsTab | undefined) => void;
  openSettings: (tab?: SettingsTab) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  commands: CommandItem[];
  prefsRevision: number;
  indexRevision: number;
  showToast: (msg: string, tone?: "default" | "success" | "error") => void;
  onPreferencesSaved: () => Promise<void>;
  handleApiReady: () => void;
  handleLlmSettingsSaved: () => void;
  handleReindexDoc: () => void;
  exportChat: () => Promise<void>;
  exportSummary: () => Promise<void>;
  toggleAgent: () => void;
  expandAgent: () => void;
  clearChat: () => void;
  requestClearChat: () => void;
  clearConfirmOpen: boolean;
  setClearConfirmOpen: (open: boolean) => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export function ShellProvider({
  value,
  children,
}: {
  value: ShellContextValue;
  children: ReactNode;
}) {
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used within ShellProvider");
  return ctx;
}
