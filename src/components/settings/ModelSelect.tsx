import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "../../i18n";
import { AnchoredMenu } from "../AnchoredMenu";
import {
  allProviderModels,
  PROVIDER_MODEL_GROUPS,
  visionModelsForProvider,
  type ProviderId,
} from "../../lib/types";
import { isVisionModel, isToolModel } from "../../lib/model-capabilities";

interface ModelSelectProps {
  provider: Exclude<ProviderId, "custom">;
  model: string;
  customModel: boolean;
  purpose: "agent" | "vision";
  onSelect: (model: string) => void;
  onCustom: () => void;
}

export function ModelSelect({
  provider,
  model,
  customModel,
  purpose,
  onSelect,
  onCustom,
}: ModelSelectProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  const presetModels =
    purpose === "vision" ? visionModelsForProvider(provider) : allProviderModels(provider);
  const inPreset = !customModel && presetModels.includes(model);
  const vision = isVisionModel(provider, model);
  const tools = isToolModel(provider, model);

  const groups =
    purpose === "vision"
      ? PROVIDER_MODEL_GROUPS[provider].filter((g) => g.labelKey.includes("Vision") || g.labelKey.includes("vision") || g.labelKey.includes("Agent"))
      : PROVIDER_MODEL_GROUPS[provider].filter((g) => !g.labelKey.includes("Vision") && !g.labelKey.includes("vision"));

  const labelKey = purpose === "agent" ? "settings.agentModel" : "settings.visionModel";

  return (
    <div className="settings-field">
      <span className="settings-field-label">{t(labelKey)}</span>
      {customModel || !inPreset ? (
        <input
          className="settings-input"
          type="text"
          value={model}
          onChange={(e) => onSelect(e.target.value)}
          placeholder="model-id"
        />
      ) : (
        <div ref={anchorRef} className="model-select-anchor">
          <button
            type="button"
            className="settings-select-trigger"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-haspopup="listbox"
          >
            <span className="model-select-value">{model}</span>
            {vision ? (
              <span className="model-select-badge">{t("settings.modelVisionBadge")}</span>
            ) : (
              <span className="model-select-badge muted">{t("settings.modelTextOnlyBadge")}</span>
            )}
            {tools ? (
              <span className="model-select-badge">{t("settings.modelToolsBadge")}</span>
            ) : (
              <span className="model-select-badge muted">{t("settings.modelChatOnlyBadge")}</span>
            )}
            <ChevronDown size={14} className="settings-select-chevron" aria-hidden />
          </button>
          <AnchoredMenu
            open={open}
            onClose={() => setOpen(false)}
            anchorRef={anchorRef}
            className="anchored-popover model-select-menu"
            align="start"
            role="listbox"
          >
            {groups.map((group) => (
              <div key={group.labelKey} className="model-select-group">
                <div className="model-select-group-label">{t(group.labelKey)}</div>
                {group.models.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="option"
                    aria-selected={model === m}
                    className={`model-select-option ${model === m ? "active" : ""}`}
                    onClick={() => {
                      onSelect(m);
                      setOpen(false);
                    }}
                  >
                    <span>{m}</span>
                    {isVisionModel(provider, m) ? (
                      <span className="model-select-badge">{t("settings.modelVisionBadge")}</span>
                    ) : null}
                    {isToolModel(provider, m) ? (
                      <span className="model-select-badge">{t("settings.modelToolsBadge")}</span>
                    ) : (
                      <span className="model-select-badge muted">{t("settings.modelChatOnlyBadge")}</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
            <div className="model-select-divider" role="separator" />
            <button
              type="button"
              role="option"
              className="model-select-option"
              onClick={() => {
                onCustom();
                setOpen(false);
              }}
            >
              {t("settings.modelCustom")}
            </button>
          </AnchoredMenu>
        </div>
      )}
      {purpose === "agent" && !customModel && inPreset && !tools && (
        <p className="settings-field-hint settings-vision-hint">{t("settings.agentNeedTools")}</p>
      )}
      {purpose === "vision" && !customModel && inPreset && !vision && (
        <p className="settings-field-hint settings-vision-hint">{t("settings.visionNeedMultimodal")}</p>
      )}
      {purpose === "agent" && !customModel && inPreset && !vision && tools && (
        <p className="settings-field-hint">{t("settings.agentVisionFallbackHint")}</p>
      )}
    </div>
  );
}
