import { useI18n } from "../../i18n";
import { IconCheck } from "../Icon";
import { PROVIDER_PRESETS, type ProviderId } from "../../lib/types";

const PRESET_IDS = Object.keys(PROVIDER_PRESETS) as (keyof typeof PROVIDER_PRESETS)[];

interface ProviderGridProps {
  /** The provider whose settings the panel is currently showing. */
  preview: ProviderId;
  /** The provider the app is actually using — not necessarily the one shown. */
  active: ProviderId;
  onSelect: (provider: ProviderId) => void;
}

/**
 * Pick which provider the panel is editing.
 *
 * Split out of AiProviderSettings, which had grown to 814 lines holding six
 * providers' form state, two async actions and the whole form. This is the part
 * with a genuinely narrow interface: two ids in, a selection out. The async
 * handlers were deliberately left where they are — they touch fifteen pieces of
 * state, and hoisting them would trade a hundred lines for a parameter list
 * nobody could read.
 *
 * The cells are buttons, not panels, which is why they keep their own surface
 * rule (see the panel taxonomy in ui.css).
 */
export function ProviderGrid({ preview, active, onSelect }: ProviderGridProps) {
  const { t } = useI18n();

  const cell = (id: ProviderId, label: string, wide = false) => {
    const isPreview = preview === id;
    const isActive = active === id;
    return (
      // raw-button: a grid cell showing a provider; the grid is the control, not each cell
      <button
        key={id}
        type="button"
        className={`provider-cell ${wide ? "provider-cell-wide " : ""}${
          isPreview ? "active" : ""
        } ${isActive ? "in-use" : ""}`}
        onClick={() => onSelect(id)}
        title={isActive ? t("settings.providerCurrentlyActive") : undefined}
      >
        <span className="provider-cell-label">{label}</span>
        {isPreview && <IconCheck size={14} />}
      </button>
    );
  };

  return (
    <div className="provider-grid">
      {PRESET_IDS.map((id) => cell(id, PROVIDER_PRESETS[id].label))}
      {cell("custom", t("settings.providerCustom"), true)}
    </div>
  );
}
