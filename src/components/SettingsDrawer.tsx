import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Info, Keyboard, SlidersHorizontal } from "lucide-react";
import { useI18n } from "../i18n";
import { IconClose } from "./Icon";
import { GeneralSettings } from "./settings/GeneralSettings";
import { SetupAssistant } from "./settings/SetupAssistant";
import { ShortcutsSettings } from "./settings/ShortcutsSettings";
import { AboutSettings } from "./settings/AboutSettings";
import { loadPreferences, patchPreferences, type SettingsTab } from "../lib/preferences";
import { reofferPlaintextMirrors } from "../lib/settings";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  /** True once a key is stored for the active provider — decides setup vs settings. */
  assistantConfigured: boolean;
  /** False while the stored settings are still being read. */
  settingsReady: boolean;
  onLlmSettingsSaved?: () => void;
  onReindexDoc?: () => void;
  onApiReady?: () => void;
  onPreferencesSaved?: () => Promise<void>;
  includeViewingPageDefault: boolean;
  onIncludeViewingPageDefaultChange: (value: boolean) => void;
  /** Reading follows the assistant: set in the Reading group (19.0). */
  followAgentDefault: boolean;
  onFollowAgentDefaultChange: (value: boolean) => void;
  /** Read every page with no text yet (the `All` end of the cloud row). */
  onScanAllPages?: () => void;
  onTestResult?: (message: string, ok: boolean) => void;
  onSaveError?: () => void;
  onRefreshConnection?: () => void;
}

const TABS = ["general", "shortcuts", "about"] as const satisfies readonly SettingsTab[];

type DrawerTab = (typeof TABS)[number];

const TAB_ICONS: Record<DrawerTab, typeof Info> = {
  general: SlidersHorizontal,
  shortcuts: Keyboard,
  about: Info,
};

/**
 * The settings surface, and the setup page a new reader gets instead.
 *
 * 18.0 removed the "AI Provider" tab: it was a second surface for one subject,
 * and its "Set active" footer made editing and using two different things. An
 * unconfigured app now opens on a single page that asks for one key, and a
 * configured one opens on three groups — appearance, reading, assistant.
 *
 * The unsaved-changes confirm is gone with the footer: every edit autosaves
 * (400ms debounce) and the hook flushes on unmount, so the drawer's close is
 * never a place where work is lost, and a dialog asking about it was a
 * leftover from when saving was manual.
 */
function SettingsDrawerInner({
  open,
  onClose,
  assistantConfigured,
  settingsReady,
  onLlmSettingsSaved,
  onReindexDoc,
  onApiReady,
  onPreferencesSaved,
  includeViewingPageDefault,
  onIncludeViewingPageDefaultChange,
  followAgentDefault,
  onFollowAgentDefaultChange,
  onScanAllPages,
  onTestResult,
  onSaveError,
  onRefreshConnection,
}: SettingsDrawerProps) {
  const { t } = useI18n();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [tab, setTab] = useState<DrawerTab>("general");
  const [visited, setVisited] = useState<Set<DrawerTab>>(() => new Set(["general"]));
  /** The reader chose "something else…" on the setup page: show the full surface. */
  const [setupSkipped, setSetupSkipped] = useState(false);

  useEffect(() => {
    if (!open) {
      setSetupSkipped(false);
      return;
    }
    // Opening Settings is the explicit action that re-asks the OS keychain, and
    // the moment a system prompt is expected. If a plaintext mirror can move
    // into the keychain now, it does — and the warning under the key field goes
    // with it (20.0: until then, a key that landed on disk once stayed there).
    void reofferPlaintextMirrors().then((moved) => {
      if (moved > 0) onApiReady?.();
    });
    void loadPreferences().then((p) => {
      const resolved = TABS.includes(p.lastSettingsTab as DrawerTab)
        ? (p.lastSettingsTab as DrawerTab)
        : "general";
      setTab(resolved);
      setVisited(new Set([resolved]));
    });
  }, [open, onApiReady]);

  const requestClose = useCallback(() => {
    onClose();
  }, [onClose]);

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

  const needsSetup = settingsReady && !assistantConfigured && !setupSkipped;

  const tabLabels: Record<DrawerTab, string> = {
    general: t("settings.general"),
    shortcuts: t("settings.shortcuts"),
    about: t("settings.about"),
  };

  return (
    <Modal
      open={open}
      onClose={requestClose}
      overlayClassName="drawer-root"
      className="drawer-panel settings-drawer"
      ariaLabel={needsSetup ? t("settings.setupTitle") : t("settings.title")}
    >
        <header className="drawer-header">
          <h2>{needsSetup ? t("settings.setupTitle") : t("settings.title")}</h2>
          <Button
            variant="ghost" size="md" icon
            onClick={requestClose}
            aria-label={t("settings.close")}
          >
            <IconClose size={14} />
          </Button>
        </header>

        {needsSetup ? (
          <div className="settings-main">
            <div className="settings-content">
              <div className="settings-pane">
                <SetupAssistant
                  onDone={onClose}
                  onSkip={() => setSetupSkipped(true)}
                  onSaveError={onSaveError}
                  onRefreshConnection={onRefreshConnection}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="settings-layout">
            <nav className="settings-nav" role="tablist" aria-label={t("settings.title")}>
              {TABS.map((id, index) => {
                const Icon = TAB_ICONS[id];
                return (
                  // raw-button: role="tab" in a tablist — a tab is not a button and must not be styled as one
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
                {visited.has("general") && (
                  <div
                    id="settings-panel-general"
                    role="tabpanel"
                    aria-labelledby="settings-tab-general"
                    hidden={tab !== "general"}
                    className="settings-pane"
                  >
                    <GeneralSettings
                      includeViewingPageDefault={includeViewingPageDefault}
                      onIncludeViewingPageDefaultChange={onIncludeViewingPageDefaultChange}
                      followAgentDefault={followAgentDefault}
                      onFollowAgentDefaultChange={onFollowAgentDefaultChange}
                      onScanAllPages={onScanAllPages}
                      onPreferencesSaved={onPreferencesSaved}
                      onLlmSettingsSaved={onLlmSettingsSaved}
                      onReindexDoc={onReindexDoc}
                      onApiReady={onApiReady}
                      onTestResult={onTestResult}
                      onSaveError={onSaveError}
                      onRefreshConnection={onRefreshConnection}
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
            </div>
          </div>
        )}
    </Modal>
  );
}

export const SettingsDrawer = memo(SettingsDrawerInner);
