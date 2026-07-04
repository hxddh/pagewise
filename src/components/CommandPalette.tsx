import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { filterCommands, sectionLabel } from "../lib/commands";
import type { CommandItem } from "../lib/commands";
import { hasSeenPaletteHint, loadRecentCommandIds, markPaletteHintSeen } from "../lib/onboarding-hints";
import { useOverlayLock } from "../hooks/useOverlayLock";
import { useFocusTrap } from "../hooks/useFocusTrap";
import {
  isTopOverlayLayer,
  popOverlayLayer,
  pushOverlayLayer,
} from "../lib/overlay-state";

interface CommandPaletteProps {
  open: boolean;
  commands: CommandItem[];
  onClose: () => void;
}

export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const { t } = useI18n();
  useOverlayLock(open);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);
  const layerRef = useRef<number | null>(null);
  useFocusTrap(open, panelRef);

  const recentCommands = useMemo(() => {
    const ids = loadRecentCommandIds();
    return ids
      .map((id) => commands.find((c) => c.id === id))
      .filter((c): c is CommandItem => !!c && !c.disabled);
  }, [commands]);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
  const showRecent = !query.trim() && recentCommands.length > 0;
  const listItems = showRecent ? recentCommands : filtered;
  const sections = useMemo(
    () => (showRecent ? ["Recent"] : [...new Set(filtered.map((c) => c.section))]),
    [showRecent, filtered],
  );

  const [showFirstHint, setShowFirstHint] = useState(false);

  useEffect(() => {
    if (!open) {
      setShowFirstHint(false);
      return;
    }
    if (!hasSeenPaletteHint()) {
      setShowFirstHint(true);
      markPaletteHintSeen();
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      return;
    }
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const layerId = pushOverlayLayer();
    layerRef.current = layerId;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopOverlayLayer(layerId)) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      popOverlayLayer(layerId);
      layerRef.current = null;
    };
  }, [open, onClose]);

  // Keep the active row visible as the selection moves.
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  async function runCommand(cmd: CommandItem) {
    onClose();
    await cmd.run();
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    // Ignore keys mid-IME-composition so Enter doesn't run a command early.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, listItems.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && listItems[activeIndex]) {
      e.preventDefault();
      void runCommand(listItems[activeIndex]);
    }
  }

  const showPaletteHint = showFirstHint;

  return (
    <div className="palette-root" role="presentation">
      <button type="button" className="palette-backdrop" aria-label={t("settings.close")} onClick={onClose} />
      <div
        ref={panelRef}
        className="palette-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("commands.title")}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={t("commands.placeholder")}
          role="combobox"
          aria-expanded
          aria-controls="palette-listbox"
          aria-activedescendant={
            listItems[activeIndex] ? `palette-option-${activeIndex}` : undefined
          }
        />
        <div className="palette-list" id="palette-listbox" role="listbox">
          {listItems.length === 0 ? (
            <p className="palette-empty">{t("commands.empty")}</p>
          ) : (
            sections.map((section) => (
              <div key={section} className="palette-section">
                <p className="palette-section-label">
                  {section === "Recent" ? t("commands.recent") : sectionLabel(section as never, t)}
                </p>
                {(showRecent ? recentCommands : filtered.filter((cmd) => cmd.section === section)).map(
                  (cmd) => {
                    const idx = listItems.indexOf(cmd);
                    const isActive = idx === activeIndex;
                    return (
                      <button
                        key={cmd.id}
                        ref={isActive ? activeItemRef : undefined}
                        id={`palette-option-${idx}`}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        className={`palette-item ${isActive ? "active" : ""}`}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => void runCommand(cmd)}
                      >
                        <span>{cmd.label}</span>
                        {cmd.shortcut && <kbd>{cmd.shortcut}</kbd>}
                      </button>
                    );
                  },
                )}
              </div>
            ))
          )}
        </div>
        <div className="palette-footer">
          <span>{t("commands.navigate")}</span>
          <span>{t("commands.run")}</span>
          <span>{t("commands.close")}</span>
          {showPaletteHint && <span className="palette-first-hint">{t("commands.firstOpenHint")}</span>}
        </div>
      </div>
    </div>
  );
}
