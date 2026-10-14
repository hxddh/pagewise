import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { filterCommands, sectionLabel } from "../lib/commands";
import type { CommandItem } from "../lib/commands";
import { hasSeenPaletteHint, loadRecentCommandIds, markPaletteHintSeen } from "../lib/onboarding-hints";
import { Input } from "./ui/Field";
import { ListRow } from "./ui/ListRow";
import { Modal } from "./ui/Modal";
import { EmptyState } from "./EmptyState";

interface CommandPaletteProps {
  open: boolean;
  commands: CommandItem[];
  onClose: () => void;
}

export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);

  const recentCommands = useMemo(() => {
    const ids = loadRecentCommandIds();
    return ids
      .map((id) => commands.find((c) => c.id === id))
      .filter((c): c is CommandItem => !!c && !c.disabled);
  }, [commands]);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
  const showRecent = !query.trim() && recentCommands.length > 0;
  // With nothing typed: the recent ones first, then everything else — before
  // 16.0 an empty query showed only the recent ones, so a palette opened for
  // the first time after one command offered that one command and nothing to
  // discover.
  const rest = useMemo(
    () => (showRecent ? filtered.filter((c) => !recentCommands.includes(c)) : filtered),
    [showRecent, filtered, recentCommands],
  );
  const listItems = useMemo(() => (showRecent ? [...recentCommands, ...rest] : rest), [showRecent, recentCommands, rest]);
  const sections = useMemo(
    () => [...(showRecent ? ["Recent"] : []), ...new Set(rest.map((c) => c.section))],
    [showRecent, rest],
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
    }
  }, [open]);

  // Keep the active row visible as the selection moves.
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

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

  return (
    <Modal
      open={open}
      onClose={onClose}
      overlayClassName="palette-root"
      className="palette-panel"
      tone="elevated"
      ariaLabel={t("commands.title")}
      initialFocus={inputRef}
    >
      <Input
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
          <EmptyState variant="inline" className="palette-empty">
            {t("commands.empty")}
          </EmptyState>
        ) : (
          sections.map((section) => (
            <div key={section} className="palette-section">
              <p className="palette-section-label">
                {section === "Recent" ? t("commands.recent") : sectionLabel(section as never, t)}
              </p>
              {(section === "Recent" ? recentCommands : rest.filter((cmd) => cmd.section === section)).map(
                (cmd) => {
                  const idx = listItems.indexOf(cmd);
                  const isActive = idx === activeIndex;
                  return (
                    <ListRow
                      key={cmd.id}
                      ref={isActive ? activeItemRef : undefined}
                      id={`palette-option-${idx}`}
                      role="option"
                      aria-selected={isActive}
                      active={isActive}
                      className="palette-item"
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => void runCommand(cmd)}
                      label={<span>{cmd.label}</span>}
                      trailing={cmd.shortcut ? <kbd>{cmd.shortcut}</kbd> : undefined}
                    />
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
        {showFirstHint && <span className="palette-first-hint">{t("commands.firstOpenHint")}</span>}
      </div>
    </Modal>
  );
}
