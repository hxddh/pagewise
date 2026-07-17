import { useCallback, useEffect, useMemo, useState } from "react";
import type { UIMessage } from "ai";
import { findLastMessage } from "../lib/messages-utils";
import { useI18n } from "../i18n";
import { ExportSummaryError, streamExportSummary } from "../lib/export-summary";
import { saveMarkdownFile } from "../lib/save-markdown";
import type { CommandItem } from "../lib/commands";
import { requestOpenDocSearch } from "../lib/events";
import type { LocaleMode } from "../lib/preferences";
import { recordCommand } from "../lib/onboarding-hints";
import { previewNextPage, previewPrevPage } from "../lib/preview-actions";
import { modKey } from "../lib/shortcut-display";
import { isOverlayOpen } from "../lib/overlay-state";

interface UseAppCommandsOptions {
  activeDocName: string | null;
  messages: UIMessage[];
  busy: boolean;
  followAgent: boolean;
  agentOpen: boolean;
  previewPage: number;
  totalPages: number;
  onOpenDocument: () => void;
  onOpenSettings: () => void;
  onToggleFollowAgent: () => void;
  onToggleAgent: () => void;
  onClearChat: () => void;
  onStop: () => void;
  onCycleTheme: () => void;
  onExportChat: () => void | Promise<void>;
  showToast: (msg: string, tone?: "default" | "success" | "error") => void;
}

const LOCALE_CYCLE: LocaleMode[] = ["system", "en", "zh-CN"];

function wrapRun(id: string, run: () => void | Promise<void>): () => void | Promise<void> {
  return () => {
    recordCommand(id);
    return run();
  };
}

export function useAppCommands({
  activeDocName,
  messages,
  busy,
  followAgent,
  agentOpen,
  previewPage,
  totalPages,
  onOpenDocument,
  onOpenSettings,
  onToggleFollowAgent,
  onToggleAgent,
  onClearChat,
  onStop,
  onCycleTheme,
  onExportChat,
  showToast,
}: UseAppCommandsOptions) {
  const { t, localeMode, setLocaleMode } = useI18n();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const mod = modKey();

  const exportChat = useCallback(async () => {
    await onExportChat();
  }, [onExportChat]);

  const exportSummary = useCallback(async () => {
    const lastAssistant = findLastMessage(messages, (m) => m.role === "assistant");
    if (!lastAssistant) {
      showToast(t("toast.noSummary"), "error");
      return;
    }
    showToast(t("toast.exportSummaryProgress"), "default");
    const name = (activeDocName ?? "summary").replace(/\.[^.]+$/, "") + "-summary.md";
    try {
      const md = await streamExportSummary(messages, {
        docName: activeDocName ?? undefined,
      });
      const ok = await saveMarkdownFile(md, name, t("dialog.markdownFilter"));
      if (ok) showToast(t("toast.summaryExported"), "success");
    } catch (error) {
      if (error instanceof ExportSummaryError && error.message === "NO_SUMMARY") {
        showToast(t("toast.noSummary"), "error");
        return;
      }
      showToast(t("toast.exportFailed"), "error");
    }
  }, [messages, activeDocName, showToast, t]);

  const cycleLanguage = useCallback(async () => {
    const next = LOCALE_CYCLE[(LOCALE_CYCLE.indexOf(localeMode) + 1) % LOCALE_CYCLE.length];
    await setLocaleMode(next);
  }, [localeMode, setLocaleMode]);

  const commands = useMemo<CommandItem[]>(
    () => [
      {
        id: "open",
        label: t("commands.openDoc"),
        section: "file",
        shortcut: `${mod}O`,
        keywords: ["file", "pdf"],
        run: wrapRun("open", onOpenDocument),
      },
      {
        id: "search-doc",
        label: t("commands.searchDoc"),
        section: "document",
        shortcut: `${mod}F`,
        keywords: ["find"],
        disabled: !activeDocName,
        run: wrapRun("search-doc", () => requestOpenDocSearch()),
      },
      {
        id: "prev-page",
        label: t("commands.prevPage"),
        section: "document",
        shortcut: `${mod}[`,
        disabled: !activeDocName || previewPage <= 1,
        run: wrapRun("prev-page", previewPrevPage),
      },
      {
        id: "next-page",
        label: t("commands.nextPage"),
        section: "document",
        shortcut: `${mod}]`,
        disabled: !activeDocName || previewPage >= totalPages,
        run: wrapRun("next-page", previewNextPage),
      },
      {
        id: "export-chat",
        label: t("commands.exportChat"),
        section: "export",
        // Busy-gated like the chat-panel menu: exporting mid-stream would
        // capture a half-streamed answer.
        disabled: messages.length === 0 || busy,
        run: wrapRun("export-chat", exportChat),
      },
      {
        id: "export-summary",
        label: t("commands.exportSummary"),
        section: "export",
        disabled: messages.length === 0 || busy,
        run: wrapRun("export-summary", exportSummary),
      },
      {
        id: "clear-chat",
        label: t("commands.clearChat"),
        section: "agent",
        disabled: messages.length === 0 || busy,
        run: wrapRun("clear-chat", onClearChat),
      },
      {
        id: "stop",
        label: t("commands.stopGen"),
        section: "agent",
        disabled: !busy,
        run: wrapRun("stop", onStop),
      },
      {
        id: "toggle-follow",
        label: followAgent ? t("commands.disableFollow") : t("commands.enableFollow"),
        section: "view",
        run: wrapRun("toggle-follow", onToggleFollowAgent),
      },
      {
        id: "toggle-agent",
        label: agentOpen ? t("commands.toggleAgent") : t("commands.showAgent"),
        section: "view",
        shortcut: `${mod}\\`,
        disabled: !activeDocName,
        run: wrapRun("toggle-agent", onToggleAgent),
      },
      {
        id: "theme",
        label: t("commands.cycleTheme"),
        section: "view",
        run: wrapRun("theme", onCycleTheme),
      },
      {
        id: "language",
        label: t("commands.switchLang"),
        section: "view",
        run: wrapRun("language", cycleLanguage),
      },
      {
        id: "settings",
        label: t("commands.openSettings"),
        section: "app",
        shortcut: `${mod},`,
        run: wrapRun("settings", onOpenSettings),
      },
    ],
    [
      activeDocName,
      agentOpen,
      busy,
      cycleLanguage,
      exportChat,
      exportSummary,
      followAgent,
      messages.length,
      mod,
      onClearChat,
      onCycleTheme,
      onOpenDocument,
      onOpenSettings,
      onStop,
      onToggleAgent,
      onToggleFollowAgent,
      previewPage,
      t,
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

      // When another overlay (settings drawer, library, confirm, etc.) is open,
      // global document/agent shortcuts must not fire underneath it. (Cmd+, to
      // open settings and Escape handling remain fine.)
      const overlayOpen = isOverlayOpen();

      if (mod && e.key.toLowerCase() === "o") {
        if (overlayOpen) return;
        e.preventDefault();
        recordCommand("open");
        void onOpenDocument();
      }
      if (mod && e.key === "\\") {
        if (overlayOpen) return;
        e.preventDefault();
        if (activeDocName) {
          recordCommand("toggle-agent");
          onToggleAgent();
        }
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        recordCommand("settings");
        onOpenSettings();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, activeDocName, onOpenDocument, onToggleAgent, onOpenSettings]);

  return { commands, paletteOpen, setPaletteOpen, exportChat, exportSummary };
}
