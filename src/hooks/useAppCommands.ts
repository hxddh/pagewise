import { useCallback, useEffect, useMemo, useState } from "react";
import type { UIMessage } from "ai";
import { chatToMarkdown, summaryToMarkdown } from "../lib/export-markdown";
import { saveMarkdownFile } from "../lib/save-markdown";
import type { CommandItem } from "../lib/commands";
import { requestOpenDocSearch } from "../lib/events";

interface UseAppCommandsOptions {
  activeDocName: string | null;
  messages: UIMessage[];
  busy: boolean;
  agentCollapsed: boolean;
  followAgent: boolean;
  previewPage: number;
  totalPages: number;
  onOpenDocument: () => void;
  onOpenSettings: () => void;
  onToggleAgent: () => void;
  onToggleFollowAgent: () => void;
  onClearChat: () => void;
  onStop: () => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onCycleTheme: () => void;
  showToast: (msg: string, tone?: "default" | "success" | "error") => void;
}

export function useAppCommands({
  activeDocName,
  messages,
  busy,
  agentCollapsed,
  followAgent,
  previewPage,
  totalPages,
  onOpenDocument,
  onOpenSettings,
  onToggleAgent,
  onToggleFollowAgent,
  onClearChat,
  onStop,
  onPrevPage,
  onNextPage,
  onCycleTheme,
  showToast,
}: UseAppCommandsOptions) {
  const [paletteOpen, setPaletteOpen] = useState(false);

  const exportChat = useCallback(async () => {
    if (messages.length === 0) {
      showToast("No messages to export", "error");
      return;
    }
    const md = chatToMarkdown(messages, activeDocName ?? undefined);
    const name = (activeDocName ?? "chat").replace(/\.[^.]+$/, "") + "-chat.md";
    const ok = await saveMarkdownFile(md, name);
    if (ok) showToast("Chat exported", "success");
  }, [messages, activeDocName, showToast]);

  const exportSummary = useCallback(async () => {
    const md = summaryToMarkdown(messages, activeDocName ?? undefined);
    const name = (activeDocName ?? "summary").replace(/\.[^.]+$/, "") + "-summary.md";
    const ok = await saveMarkdownFile(md, name);
    if (ok) showToast("Summary exported", "success");
  }, [messages, activeDocName, showToast]);

  const commands = useMemo<CommandItem[]>(
    () => [
      {
        id: "open",
        label: "Open document",
        section: "File",
        shortcut: "⌘O",
        keywords: ["file", "pdf", "import"],
        run: onOpenDocument,
      },
      {
        id: "search-doc",
        label: "Search in document",
        section: "Document",
        shortcut: "⌘F",
        keywords: ["find", "text"],
        disabled: !activeDocName,
        run: () => requestOpenDocSearch(),
      },
      {
        id: "prev-page",
        label: "Previous page",
        section: "Document",
        shortcut: "⌘[",
        disabled: !activeDocName || previewPage <= 1,
        run: onPrevPage,
      },
      {
        id: "next-page",
        label: "Next page",
        section: "Document",
        shortcut: "⌘]",
        disabled: !activeDocName || previewPage >= totalPages,
        run: onNextPage,
      },
      {
        id: "export-chat",
        label: "Export chat as Markdown",
        section: "Export",
        keywords: ["download", "save"],
        disabled: messages.length === 0,
        run: exportChat,
      },
      {
        id: "export-summary",
        label: "Export summary as Markdown",
        section: "Export",
        keywords: ["download", "save", "last"],
        disabled: messages.length === 0,
        run: exportSummary,
      },
      {
        id: "clear-chat",
        label: "Clear chat",
        section: "Agent",
        disabled: messages.length === 0 || busy,
        run: onClearChat,
      },
      {
        id: "stop",
        label: "Stop generation",
        section: "Agent",
        disabled: !busy,
        run: onStop,
      },
      {
        id: "toggle-agent",
        label: agentCollapsed ? "Show agent panel" : "Hide agent panel",
        section: "View",
        shortcut: "⌘B",
        run: onToggleAgent,
      },
      {
        id: "toggle-follow",
        label: followAgent ? "Disable follow agent" : "Enable follow agent",
        section: "View",
        run: onToggleFollowAgent,
      },
      {
        id: "theme",
        label: "Cycle theme (dark / light / system)",
        section: "View",
        shortcut: "⌘\\",
        keywords: ["appearance", "dark", "light"],
        run: onCycleTheme,
      },
      {
        id: "settings",
        label: "Open settings",
        section: "App",
        shortcut: "⌘,",
        run: onOpenSettings,
      },
    ],
    [
      activeDocName,
      agentCollapsed,
      busy,
      exportChat,
      exportSummary,
      followAgent,
      messages.length,
      onClearChat,
      onCycleTheme,
      onNextPage,
      onOpenDocument,
      onOpenSettings,
      onPrevPage,
      onStop,
      onToggleAgent,
      onToggleFollowAgent,
      previewPage,
      totalPages,
    ],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }

      if (paletteOpen) return;

      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void onOpenDocument();
      }
      if (mod && e.key === "b") {
        e.preventDefault();
        onToggleAgent();
      }
      if (mod && e.key === "\\") {
        e.preventDefault();
        void onCycleTheme();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, onOpenDocument, onToggleAgent, onCycleTheme]);

  return { commands, paletteOpen, setPaletteOpen, exportChat, exportSummary };
}
