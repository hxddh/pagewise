export type CommandSection = "file" | "document" | "export" | "agent" | "view" | "app";

export interface CommandItem {
  id: string;
  label: string;
  section: CommandSection;
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

export function sectionLabel(section: CommandSection, t: (key: string) => string): string {
  const map: Record<CommandSection, string> = {
    file: t("commands.sectionFile"),
    document: t("commands.sectionDocument"),
    export: t("commands.sectionExport"),
    agent: t("commands.sectionAgent"),
    view: t("commands.sectionView"),
    app: t("commands.sectionApp"),
  };
  return map[section];
}

export type ShortcutSection = "file" | "document" | "agent" | "view" | "app";

export interface ShortcutRow {
  keys: string;
  description: string;
  section: ShortcutSection;
}

export function getShortcutRows(
  t: (key: string) => string,
  mod: string,
): ShortcutRow[] {
  return [
    { section: "app", keys: `${mod}K`, description: t("commands.title") },
    { section: "app", keys: `${mod},`, description: t("commands.openSettings") },
    { section: "file", keys: `${mod}O`, description: t("commands.openDoc") },
    { section: "document", keys: `${mod}F`, description: t("commands.searchDoc") },
    {
      section: "document",
      keys: `${mod}[ / ${mod}]`,
      description: `${t("commands.prevPage")} / ${t("commands.nextPage")}`,
    },
    { section: "agent", keys: `${mod}\\`, description: t("commands.showAgent") },
    { section: "view", keys: "Esc", description: t("commands.closeOverlay") },
  ];
}

export function shortcutSectionLabel(section: ShortcutSection, t: (key: string) => string): string {
  const map: Record<ShortcutSection, string> = {
    file: t("commands.sectionFile"),
    document: t("commands.sectionDocument"),
    agent: t("commands.sectionAgent"),
    view: t("commands.sectionView"),
    app: t("commands.sectionApp"),
  };
  return map[section];
}
