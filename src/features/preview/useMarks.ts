import { useEffect, useState } from "react";
import { subscribeMarks } from "../../lib/mark-store";

/**
 * A counter that changes whenever this document's marks do.
 *
 * The marks themselves live in the store's memory copy, so components read them
 * synchronously (`marksOnPage`) and use this only to know when to look again —
 * the same reason the layers take a `revision` rather than an array.
 */
export function useMarkRevision(path: string): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setRevision((n) => n + 1);
    return subscribeMarks((changed) => {
      if (changed === path) setRevision((n) => n + 1);
    });
  }, [path]);
  return revision;
}
