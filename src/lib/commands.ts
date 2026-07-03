export interface CommandItem {
  id: string;
  label: string;
  section: string;
  keywords?: string[];
  shortcut?: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

export function filterCommands(commands: CommandItem[], query: string): CommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.filter((c) => !c.disabled);

  return commands
    .filter((c) => !c.disabled)
    .filter((c) => {
      const hay = [c.label, c.section, ...(c.keywords ?? [])].join(" ").toLowerCase();
      return q.split(/\s+/).every((token) => hay.includes(token));
    });
}

export const SHORTCUTS_REFERENCE: Array<{ keys: string; description: string }> = [
  { keys: "⌘K", description: "Command palette" },
  { keys: "⌘O", description: "Open document" },
  { keys: "⌘,", description: "Settings" },
  { keys: "⌘F", description: "Search in document" },
  { keys: "⌘[ / ⌘]", description: "Previous / next page" },
  { keys: "⌘B", description: "Toggle agent panel" },
  { keys: "⌘\\", description: "Toggle theme" },
  { keys: "Esc", description: "Close palette / stop focus" },
];
