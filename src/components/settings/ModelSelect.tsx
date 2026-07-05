import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "../../i18n";
import { AnchoredMenu } from "../AnchoredMenu";
import {
  agentPresetModels,
  visionPresetModels,
  type ProviderId,
} from "../../lib/types";
import { isVisionModel, isToolModel } from "../../lib/model-capabilities";

interface ModelSelectProps {
  provider: Exclude<ProviderId, "custom">;
  model: string;
  customModel: boolean;
  purpose: "agent" | "vision";
  onPresetSelect: (model: string) => void;
  onCustomChange: (model: string) => void;
  onEnterCustom: () => void;
}

export function ModelSelect({
  provider,
  model,
  customModel,
  purpose,
  onPresetSelect,
  onCustomChange,
  onEnterCustom,
}: ModelSelectProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  const presetModels =
    purpose === "vision" ? visionPresetModels(provider) : agentPresetModels(provider);
  const hasPresets = presetModels.length > 0;
  const inPreset = presetModels.includes(model);
  const isCustomValue = customModel || !inPreset;
  const vision = isVisionModel(provider, model);
  const tools = isToolModel(provider, model);

  const labelKey = purpose === "agent" ? "settings.agentModel" : "settings.scanModel";
  const hintKey = purpose === "agent" ? "settings.agentModelHint" : "settings.scanModelHint";

  if (!hasPresets) {
    return (
      <div className="settings-field">
        <span className="settings-field-label">{t(labelKey)}</span>
        <p className="settings-field-hint">{t(hintKey)}</p>
        <input
          className="settings-input"
          type="text"
          value={model}
          onChange={(e) => onCustomChange(e.target.value)}
          placeholder="model-id"
        />
      </div>
    );
  }

  return (
    <div className="settings-field">
      <span className="settings-field-label">{t(labelKey)}</span>
      <p className="settings-field-hint">{t(hintKey)}</p>
      <div ref={anchorRef} className="model-select-anchor">
        <button
          type="button"
          className="settings-select-trigger"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="listbox"
        >
          <span className="model-select-value">{model || t("settings.modelSelectPlaceholder")}</span>
          {isCustomValue ? (
            <span className="model-select-badge muted">{t("settings.modelCustomBadge")}</span>
          ) : null}
          {vision ? (
            <span className="model-select-badge">{t("settings.modelVisionBadge")}</span>
          ) : (
            <span className="model-select-badge muted">{t("settings.modelTextOnlyBadge")}</span>
          )}
          {purpose === "agent" ? (
            tools ? (
              <span className="model-select-badge">{t("settings.modelToolsBadge")}</span>
            ) : (
              <span className="model-select-badge muted">{t("settings.modelChatOnlyBadge")}</span>
            )
          ) : null}
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
          {presetModels.map((m) => (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={model === m && !customModel}
              className={`model-select-option ${model === m && !customModel ? "active" : ""}`}
              onClick={() => {
                onPresetSelect(m);
                setOpen(false);
              }}
            >
              <span>{m}</span>
              {isVisionModel(provider, m) ? (
                <span className="model-select-badge">{t("settings.modelVisionBadge")}</span>
              ) : null}
              {purpose === "agent" ? (
                isToolModel(provider, m) ? (
                  <span className="model-select-badge">{t("settings.modelToolsBadge")}</span>
                ) : (
                  <span className="model-select-badge muted">{t("settings.modelChatOnlyBadge")}</span>
                )
              ) : null}
            </button>
          ))}
          <div className="model-select-divider" role="separator" />
          <button
            type="button"
            role="option"
            aria-selected={customModel}
            className={`model-select-option ${customModel ? "active" : ""}`}
            onClick={() => {
              onEnterCustom();
              setOpen(false);
            }}
          >
            {t("settings.modelCustom")}
          </button>
        </AnchoredMenu>
      </div>
      {customModel && (
        <input
          className="settings-input model-select-custom-input"
          type="text"
          value={model}
          onChange={(e) => onCustomChange(e.target.value)}
          placeholder="model-id"
          aria-label={t("settings.modelCustomInputLabel")}
        />
      )}
      {purpose === "agent" && !customModel && inPreset && !tools && (
        <p className="settings-field-hint settings-vision-hint">{t("settings.agentNeedTools")}</p>
      )}
      {purpose === "vision" && !customModel && inPreset && !vision && (
        <p className="settings-field-hint settings-vision-hint">{t("settings.scanNeedMultimodal")}</p>
      )}
      {purpose === "agent" && !customModel && inPreset && !vision && tools && (
        <p className="settings-field-hint">{t("settings.agentVisionFallbackHint")}</p>
      )}
    </div>
  );
}
