import { useI18n } from "../../i18n";
import { getShortcutRows, shortcutSectionLabel, type ShortcutSection } from "../../lib/commands";
import { modKey } from "../../lib/shortcut-display";

const SECTION_ORDER: ShortcutSection[] = ["file", "document", "agent", "view", "app"];

export function ShortcutsSettings() {
  const { t } = useI18n();
  const rows = getShortcutRows(t, modKey());

  return (
    <div className="settings-page">
      <h3 className="settings-page-title">{t("settings.shortcuts")}</h3>
      <section className="settings-card">
        {SECTION_ORDER.map((section) => {
          const sectionRows = rows.filter((r) => r.section === section);
          if (sectionRows.length === 0) return null;
          return (
            <div key={section}>
              <div className="shortcuts-section-label">{shortcutSectionLabel(section, t)}</div>
              <ul className="shortcuts-grid">
                {sectionRows.map((row) => (
                  <li key={row.keys}>
                    <kbd>{row.keys}</kbd>
                    <span>{row.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>
    </div>
  );
}
