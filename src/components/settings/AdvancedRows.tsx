import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { clearIndexCache, getIndexCacheStats, type IndexCacheStats } from "../../lib/index-store";
import { clearOcrCache, getOcrCacheStats } from "../../lib/ocr/ocr-store";
import { Button } from "../ui/Button";

interface AdvancedRowsProps {
  includeViewingPageDefault: boolean;
  onIncludeViewingPageDefaultChange: (value: boolean) => void;
  /** The thinking switch is only offered for models that support it. */
  showThinking: boolean;
  thinkingEnabled: boolean;
  onThinkingChange: (value: boolean) => void;
}

/**
 * The rows behind the assistant's Advanced disclosure (19.0).
 *
 * Its own file on purpose. Settings counts the rows a reader sees with
 * Advanced closed — that is the surface the 19.0 budget is about — and a row
 * that lives here is not one of them. Keeping them in `AssistantSettings.tsx`
 * would have left the count reading as though nothing had moved, which is the
 * same failure as a metric that can be met by redefining it.
 *
 * Three rows: the current-page screenshot (an expert switch — it changes what
 * every question costs), extended thinking (a per-model option), and the text
 * read from pages, with the one action that clears it. The last one is a
 * maintenance action, not a preference, which is why it is here rather than in
 * the Reading group where it used to sit.
 */
export function AdvancedRows({
  includeViewingPageDefault,
  onIncludeViewingPageDefaultChange,
  showThinking,
  thinkingEnabled,
  onThinkingChange,
}: AdvancedRowsProps) {
  const { t } = useI18n();
  const [cacheStats, setCacheStats] = useState<IndexCacheStats | null>(null);
  const [ocrStats, setOcrStats] = useState<{ bytes: number; docs: number } | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

  useEffect(() => {
    let alive = true;
    // Stats are best-effort: a failed read leaves the row on its placeholder
    // rather than breaking the settings page.
    getIndexCacheStats()
      .then((stats) => {
        if (alive) setCacheStats(stats);
      })
      .catch(() => {});
    void getOcrCacheStats().then((stats) => {
      if (alive) setOcrStats(stats);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** Both stores of text read from pages — by OCR and by the cloud — cleared together. */
  async function onClearCache() {
    setClearingCache(true);
    try {
      await Promise.all([clearIndexCache(), clearOcrCache()]);
      setCacheStats({ docs: 0, pages: 0, chars: 0 });
      setOcrStats({ bytes: 0, docs: 0 });
    } finally {
      setClearingCache(false);
    }
  }

  return (
    <>
      <label className="settings-row-toggle">
        <div>
          <span className="settings-row-title">{t("settings.includeViewingPage")}</span>
          <span className="settings-row-hint">{t("settings.includeViewingPageHint")}</span>
        </div>
        <input
          type="checkbox"
          checked={includeViewingPageDefault}
          onChange={(e) => onIncludeViewingPageDefaultChange(e.target.checked)}
        />
      </label>

      {showThinking && (
        <label className="settings-row-toggle">
          <div>
            <span className="settings-row-title">{t("settings.thinkingMode")}</span>
            <span className="settings-row-hint">{t("settings.thinkingHint")}</span>
          </div>
          <input
            type="checkbox"
            checked={thinkingEnabled}
            onChange={(e) => onThinkingChange(e.target.checked)}
          />
        </label>
      )}

      <div className="settings-row">
        <div>
          <span className="settings-row-title">{t("settings.readPagesCache")}</span>
          <span className="settings-row-hint">
            {cacheStats === null || ocrStats === null
              ? t("settings.scanCacheLoading")
              : cacheStats.pages === 0 && ocrStats.docs === 0
                ? t("settings.scanCacheEmpty")
                : t("settings.readPagesCacheStats", {
                    docs: Math.max(cacheStats.docs, ocrStats.docs),
                    size: formatChars(cacheStats.chars + ocrStats.bytes),
                  })}
          </span>
        </div>
        <Button
          variant="ghost" size="md"
          disabled={clearingCache || !cacheStats || !ocrStats || (cacheStats.pages === 0 && ocrStats.docs === 0)}
          onClick={() => void onClearCache()}
        >
          {clearingCache ? t("settings.scanCacheClearing") : t("settings.scanCacheClear")}
        </Button>
      </div>
    </>
  );
}

/** Approximate on-disk footprint; stored text is UTF-16 in memory, ~1 byte/char as JSON ASCII. */
function formatChars(chars: number): string {
  const kb = chars / 1024;
  if (kb < 1024) return `${Math.max(1, Math.round(kb))} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
