import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { Button } from "../../components/ui/Button";
import {
  cancelReading,
  readingProgress,
  subscribeReadingProgress,
} from "../../document/index-queue";

/**
 * What this document is being read as, and the way to stop it (19.0).
 *
 * A scan used to be read in silence: pages appeared with text and nothing said
 * how many were coming, which is indistinguishable from an app that has
 * stopped. The line is quiet on purpose — a page number and a total, in the
 * corner of the chrome, where the reader's eye already goes for the index
 * badge — and Cancel stops the rest of the pass without throwing away the page
 * being recognised.
 *
 * It draws nothing at all when nothing is being read, which is most of the
 * time.
 */
export function ReadingLine({ path }: { path: string }) {
  const { t } = useI18n();
  const [progress, setProgress] = useState(() => readingProgress(path));

  useEffect(() => {
    setProgress(readingProgress(path));
    return subscribeReadingProgress(() => setProgress(readingProgress(path)));
  }, [path]);

  if (!progress) return null;

  return (
    <div className="preview-reading-line">
      <span className="preview-reading-text">
        {t("preview.readingPageOf", { page: progress.page, count: progress.total })}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="preview-reading-cancel"
        title={t("preview.stopReading")}
        aria-label={t("preview.stopReading")}
        onClick={() => cancelReading(path)}
      >
        {t("common.cancel")}
      </Button>
    </div>
  );
}
