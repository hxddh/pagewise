import { useEffect, useMemo, useRef, useState } from "react";
import { filterCommands, SHORTCUTS_REFERENCE, type CommandItem } from "../lib/commands";

interface CommandPaletteProps {
  open: boolean;
  commands: CommandItem[];
  onClose: () => void;
}

export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);

  const sections = useMemo(() => [...new Set(filtered.map((c) => c.section))], [filtered]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      return;
    }
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function runCommand(cmd: CommandItem) {
    onClose();
    await cmd.run();
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[activeIndex]) {
      e.preventDefault();
      void runCommand(filtered[activeIndex]);
    }
  }

  return (
    <div className="palette-root" role="presentation">
      <button type="button" className="palette-backdrop" aria-label="Close" onClick={onClose} />
      <div className="palette-panel" role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Type a command…"
        />
        <div className="palette-list">
          {filtered.length === 0 ? (
            <p className="palette-empty">No matching commands</p>
          ) : (
            sections.map((section) => (
              <div key={section} className="palette-section">
                <p className="palette-section-label">{section}</p>
                {filtered
                  .filter((cmd) => cmd.section === section)
                  .map((cmd) => {
                    const idx = filtered.indexOf(cmd);
                    return (
                      <button
                        key={cmd.id}
                        type="button"
                        className={`palette-item ${idx === activeIndex ? "active" : ""}`}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => void runCommand(cmd)}
                      >
                        <span>{cmd.label}</span>
                        {cmd.shortcut && <kbd>{cmd.shortcut}</kbd>}
                      </button>
                    );
                  })}
              </div>
            ))
          )}
        </div>
        <div className="palette-footer">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
        <details className="palette-shortcuts">
          <summary>Keyboard shortcuts</summary>
          <ul>
            {SHORTCUTS_REFERENCE.map((s) => (
              <li key={s.keys}>
                <kbd>{s.keys}</kbd> {s.description}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}
