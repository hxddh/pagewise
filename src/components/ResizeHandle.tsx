import { useI18n } from "../i18n";

interface ResizeHandleProps {
  onPointerDown: (e: React.PointerEvent) => void;
}

export function ResizeHandle({ onPointerDown }: ResizeHandleProps) {
  const { t } = useI18n();
  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={t("agent.resizePanel")}
      onPointerDown={onPointerDown}
    />
  );
}
