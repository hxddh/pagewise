import { useRef, useState } from "react";
import { FileText, MessagesSquare, Highlighter } from "lucide-react";
import { useI18n } from "../i18n";
import { ListRow } from "./ui/ListRow";
import { Modal } from "./ui/Modal";

export type ExportChoice = "report" | "pdf" | "chat";

export interface ExportAvailability {
  /** Findings or marks to write — a report of nothing is not offered. */
  report: boolean;
  /** A PDF is open. */
  pdf: boolean;
  /** There is a conversation. */
  chat: boolean;
}

interface ExportDialogProps {
  open: boolean;
  available: ExportAvailability;
  /** Streaming: a half-written answer is not exported. */
  busy: boolean;
  onExport: (choice: ExportChoice, options: { includeText: boolean }) => void;
  onClose: () => void;
}

/**
 * Everything the app writes out, in one place (16.0).
 *
 * Before, seven exports sat across three surfaces — four in the chat menu,
 * five in the palette, one under each table — and which one was where was a
 * matter of history. Now there are three things a reader takes away: what was
 * established about the document (the report), the document itself with that
 * evidence on its pages, and the conversation. Every menu and the palette open
 * this; only a table's CSV stays under its table, where it belongs.
 */
export function ExportDialog({ open, available, busy, onExport, onClose }: ExportDialogProps) {
  const { t } = useI18n();
  const firstRef = useRef<HTMLButtonElement>(null);
  const [includeText, setIncludeText] = useState(false);

  const choose = (choice: ExportChoice) => {
    onClose();
    onExport(choice, { includeText });
  };

  const rows: Array<{ id: ExportChoice; icon: typeof FileText; enabled: boolean; why?: string }> = [
    { id: "report", icon: FileText, enabled: available.report, why: t("export.reportEmpty") },
    { id: "pdf", icon: Highlighter, enabled: available.pdf, why: t("export.pdfOnly") },
    { id: "chat", icon: MessagesSquare, enabled: available.chat && !busy, why: busy ? t("export.busy") : t("export.chatEmpty") },
  ];
  const firstEnabled = rows.find((r) => r.enabled)?.id;

  return (
    <Modal
      open={open}
      onClose={onClose}
      overlayClassName="palette-root"
      className="palette-panel export-panel"
      tone="elevated"
      ariaLabelledBy="export-title"
      initialFocus={firstRef}
    >
      <h2 id="export-title" className="export-title">
        {t("export.title")}
      </h2>
      <div className="export-options">
        {rows.map((row) => (
          <div key={row.id} className="export-option-wrap">
            <ListRow
              ref={row.id === firstEnabled ? firstRef : undefined}
              className="export-option"
              disabled={!row.enabled}
              onClick={() => choose(row.id)}
              leading={<row.icon size={18} aria-hidden className="export-option-icon" />}
              label={
                <span className="export-option-text">
                  <span className="export-option-name">{t(`export.${row.id}`)}</span>
                  <span className="export-option-desc">{row.enabled ? t(`export.${row.id}Desc`) : row.why}</span>
                </span>
              }
            />
            {row.id === "report" && row.enabled && (
              <label className="export-option-extra">
                <input type="checkbox" checked={includeText} onChange={(e) => setIncludeText(e.target.checked)} />
                {t("export.includeText")}
              </label>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
