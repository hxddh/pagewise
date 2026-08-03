import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { useOverlayLock } from "../../hooks/useOverlayLock";
import {
  isTopOverlayLayer,
  popOverlayLayer,
  pushOverlayLayer,
} from "../../lib/overlay-state";

interface PasswordPromptProps {
  open: boolean;
  /** Name of the document being opened, so the prompt says which file. */
  fileName: string;
  /** A password was already tried and rejected. */
  retry: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

/**
 * Ask for a PDF's password.
 *
 * The password is handed to a single parse and then dropped. It is deliberately
 * not offered to the keychain: that holds the user's own API credentials, and a
 * document's password is somebody else's secret to keep.
 */
export function PasswordPrompt({
  open,
  fileName,
  retry,
  onSubmit,
  onCancel,
}: PasswordPromptProps) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useOverlayLock(open);

  // Clear between attempts so a rejected password is never left in the field.
  useEffect(() => {
    if (open) setPassword("");
  }, [open, retry]);

  useEffect(() => {
    if (!open) return;
    const layerId = pushOverlayLayer();
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isTopOverlayLayer(layerId)) {
        e.preventDefault();
        e.stopPropagation();
        onCancelRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      popOverlayLayer(layerId);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="global-confirm">
      <form
        className="confirm-bar password-prompt"
        role="alertdialog"
        aria-live="assertive"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) onSubmit(password);
        }}
      >
        <p className="confirm-bar-message">{t("dialog.passwordTitle", { name: fileName })}</p>
        <input
          ref={inputRef}
          type="password"
          className="password-input"
          value={password}
          autoComplete="off"
          spellCheck={false}
          aria-label={t("dialog.passwordLabel")}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="password-hint">
          {retry ? t("dialog.passwordWrong") : t("dialog.passwordHint")}
        </p>
        <div className="confirm-bar-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!password}>
            {t("dialog.passwordOpen")}
          </button>
        </div>
      </form>
    </div>
  );
}
