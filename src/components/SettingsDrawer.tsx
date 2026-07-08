import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Info, Keyboard, SlidersHorizontal, Sparkles } from "lucide-react";
import { useI18n } from "../i18n";
import { IconClose } from "./Icon";
import { ConfirmBar } from "./ConfirmBar";
import { GeneralSettings } from "./settings/GeneralSettings";
import {
  AiProviderSettings,
  type AiSettingsFooterState,
} from "./settings/AiProviderSettings";
import { ShortcutsSettings } from "./settings/ShortcutsSettings";
import { AboutSettings } from "./settings/AboutSettings";
import { loadPreferences, patchPreferences, type SettingsTab } from "../lib/preferences";
import { useOverlayLock } from "../hooks/useOverlayLock";
import { useFocusTrap } from "../hooks/useFocusTrap";
import {
  isTopOverlayLayer,
  popOverlayLayer,
  pushOverlayLayer,
} from "../lib/overlay-state";

interface SettingsDrawerProps {
  open: boolean;
  initialTab?: SettingsTab;
  onClose: () => void;
  onLlmSettingsSaved?: () => void;
  onReindexDoc?: () => void;
  onApiReady?: () => void;
  onPreferencesSaved?: () => Promise<void>;
  followAgentDefault: boolean;
  onFollowAgentDefaultChange: (value: boolean) => void;
  includeViewingPageDefault: boolean;
  onIncludeViewingPageDefaultChange: (value: boolean) => void;
  onTestResult?: (message: string, ok: boolean) => void;
  onSaveError?: () => void;
}

const TABS = ["ai", "general", "shortcuts", "about"] as const satisfies readonly SettingsTab[];

type DrawerTab = (typeof TABS)[number];

const TAB_ICONS: Record<DrawerTab, typeof Sparkles> = {
  ai: Sparkles,
  general: SlidersHorizontal,
  shortcuts: Keyboard,
  about: Info,
};

function SettingsDrawerInner({
  open,
  initialTab,
  onClose,
  onLlmSettingsSaved,
  onReindexDoc,
  onApiReady,
  onPreferencesSaved,
  followAgentDefault,
  onFollowAgentDefaultChange,
  includeViewingPageDefault,
  onIncludeViewingPageDefaultChange,
  onTestResult,
  onSaveError,
}: SettingsDrawerProps) {
  const { t } = useI18n();
  useOverlayLock(open);
  const panelRef = useRef<HTMLElement>(null);
  useFocusTrap(open, panelRef);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [tab, setTab] = useState<DrawerTab>("ai");
  const [visited, setVisited] = useState<Set<DrawerTab>>(() => new Set(["ai"]));
  const [aiFooter, setAiFooter] = useState<AiSettingsFooterState | null>(null);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    loadPreferences().then((p) => {
      const next = initialTab ?? p.lastSettingsTab ?? "ai";
      const resolved = TABS.includes(next as DrawerTab) ? (next as DrawerTab) : "ai";
      setTab(resolved);
      setVisited(new Set([resolved]));
    });
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) {
      setCloseConfirmOpen(false);
    }
  }, [open]);

  const requestClose = useCallback(() => {
    if (aiFooter?.dirty) {
      setCloseConfirmOpen(true);
      return;
    }
    onClose();
  }, [aiFooter?.dirty, onClose]);

  // Read the latest requestClose from a ref so the escape-layer effect below can
  // depend only on `open`. Otherwise requestClose's identity (which changes with
  // aiFooter.dirty) would pop+re-push the layer on an unrelated autosave tick,
  // shoving this drawer above a higher overlay and mis-routing Escape.
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  useEffect(() => {
    if (!open) return;
    const layerId = pushOverlayLayer();
    const onKey = (e: KeyboardEvent) => {
      // Only the topmost overlay layer reacts to Escape. When the close-confirm
      // ConfirmBar is open it owns a higher layer and handles Escape itself.
      if (e.key === "Escape" && isTopOverlayLayer(layerId)) {
        requestCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      popOverlayLayer(layerId);
    };
  }, [open]);

  async function selectTab(next: DrawerTab) {
    setTab(next);
    setVisited((prev) => new Set(prev).add(next));
    await patchPreferences({ lastSettingsTab: next });
  }

  function onTabKeyDown(e: React.KeyboardEvent, index: number) {
    let next = index;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % TABS.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + TABS.length) % TABS.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = TABS.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    void selectTab(TABS[next]!);
    tabRefs.current[next]?.focus();
  }

  if (!open) return null;

  const tabLabels: Record<DrawerTab, string> = {
    ai: t("settings.aiProvider"),
    general: t("settings.general"),
    shortcuts: t("settings.shortcuts"),
    about: t("settings.about"),
  };

  const footerStatusClass =
    aiFooter?.saveStatus === "saved"
      ? "saved"
      : aiFooter?.saveStatus === "error"
        ? "error"
        : aiFooter?.dirty
          ? "unsaved"
          : "";

  return (
    <div className="drawer-root" role="presentation">
      <button
        type="button"
        className="drawer-backdrop"
        aria-label={t("settings.close")}
        onClick={requestClose}
      />
      <aside
        ref={panelRef}
        className="drawer-panel settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.title")}
      >
        <header className="drawer-header">
          <h2>{t("settings.title")}</h2>
          <button
            type="button"
            className="btn icon-btn"
            onClick={requestClose}
            aria-label={t("settings.close")}
          >
            <IconClose size={14} />
          </button>
        </header>

        <div className="settings-layout">
          <nav className="settings-nav" role="tablist" aria-label={t("settings.title")}>
            {TABS.map((id, index) => {
              const Icon = TAB_ICONS[id];
              return (
                <button
                  key={id}
                  ref={(el) => {
                    tabRefs.current[index] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`settings-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls={`settings-panel-${id}`}
                  tabIndex={tab === id ? 0 : -1}
                  className={`settings-nav-item ${tab === id ? "active" : ""}`}
                  onClick={() => void selectTab(id)}
                  onKeyDown={(e) => onTabKeyDown(e, index)}
                >
                  <Icon size={14} strokeWidth={1.75} />
                  {tabLabels[id]}
                </button>
              );
            })}
          </nav>

          <div className="settings-main">
            <div className="settings-content">
              {visited.has("ai") && (
                <div
                  id="settings-panel-ai"
                  role="tabpanel"
                  aria-labelledby="settings-tab-ai"
                  hidden={tab !== "ai"}
                  className="settings-pane"
                >
                  <AiProviderSettings
                    onLlmSettingsSaved={onLlmSettingsSaved}
                    onReindexDoc={onReindexDoc}
                    onTestResult={onTestResult}
                    onApiReady={onApiReady}
                    onSaveError={onSaveError}
                    onFooterState={setAiFooter}
                  />
                </div>
              )}
              {visited.has("general") && (
                <div
                  id="settings-panel-general"
                  role="tabpanel"
                  aria-labelledby="settings-tab-general"
                  hidden={tab !== "general"}
                  className="settings-pane"
                >
                  <GeneralSettings
                    followAgentDefault={followAgentDefault}
                    onFollowAgentDefaultChange={onFollowAgentDefaultChange}
                    includeViewingPageDefault={includeViewingPageDefault}
                    onIncludeViewingPageDefaultChange={onIncludeViewingPageDefaultChange}
                    onPreferencesSaved={onPreferencesSaved}
                  />
                </div>
              )}
              {visited.has("shortcuts") && (
                <div
                  id="settings-panel-shortcuts"
                  role="tabpanel"
                  aria-labelledby="settings-tab-shortcuts"
                  hidden={tab !== "shortcuts"}
                  className="settings-pane"
                >
                  <ShortcutsSettings />
                </div>
              )}
              {visited.has("about") && (
                <div
                  id="settings-panel-about"
                  role="tabpanel"
                  aria-labelledby="settings-tab-about"
                  hidden={tab !== "about"}
                  className="settings-pane"
                >
                  <AboutSettings />
                </div>
              )}
            </div>

            {tab === "ai" && aiFooter && (
              <footer className="settings-footer">
                <span className={`settings-footer-status ${footerStatusClass}`}>
                  {aiFooter.saveStatusLabel ?? t("settings.autoSaved")}
                </span>
                <div className="settings-footer-actions">
                  <button
                    type="button"
                    className="settings-btn-secondary"
                    onClick={aiFooter.onSetActive}
                    disabled={!aiFooter.canSetActive || aiFooter.settingActive}
                  >
                    {aiFooter.settingActive
                      ? t("settings.settingActive")
                      : aiFooter.previewIsActive
                        ? t("settings.currentlyActive")
                        : t("settings.setAsActive")}
                  </button>
                  <button
                    type="button"
                    className="settings-btn-primary"
                    onClick={aiFooter.onTest}
                    disabled={aiFooter.testing}
                  >
                    {aiFooter.testing ? t("settings.testing") : t("settings.testConnection")}
                  </button>
                </div>
              </footer>
            )}
          </div>
        </div>

        {closeConfirmOpen && (
          <div className="settings-close-confirm">
            <ConfirmBar
              message={t("settings.discardUnsaved")}
              confirmLabel={t("settings.discardAndClose")}
              onConfirm={() => {
                void aiFooter?.onDiscard().then(() => onClose());
              }}
              onCancel={() => setCloseConfirmOpen(false)}
            />
          </div>
        )}
      </aside>
    </div>
  );
}

export const SettingsDrawer = memo(SettingsDrawerInner);
