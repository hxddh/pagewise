import { useEffect } from "react";
import { SettingsForm } from "./SettingsForm";

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

export function SettingsDrawer({ open, onClose, onSaved }: SettingsDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="drawer-root" role="presentation">
      <button
        type="button"
        className="drawer-backdrop"
        aria-label="Close settings"
        onClick={onClose}
      />
      <aside className="drawer-panel" role="dialog" aria-label="Settings">
        <header className="drawer-header">
          <h2>Settings</h2>
          <button type="button" className="btn icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="drawer-body">
          <SettingsForm onSaved={onSaved} />
        </div>
      </aside>
    </div>
  );
}
