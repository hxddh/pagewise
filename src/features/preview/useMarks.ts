import { useEffect, useState } from "react";
import { subscribeMarks } from "../../lib/mark-store";
import { subscribeFindings } from "../../lib/finding-store";

/**
 * A counter that changes whenever this document's record does.
 *
 * The entries themselves live in the stores' memory copies, so components read
 * them synchronously (`marksOnPage`, `getFindings`) and use this only to know
 * when to look again — the same reason the layers take a `revision` rather than
 * an array.
 *
 * Both stores feed it. They are separate files for a reason the mark store's
 * version check makes unavoidable, but the sidebar shows one list, and a
 * counter that only moved for half of it would leave a finding on screen
 * invisible until the reader happened to mark something.
 */
export function useMarkRevision(path: string): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setRevision((n) => n + 1);
    const bump = (changed: string) => {
      if (changed === path) setRevision((n) => n + 1);
    };
    const unsubMarks = subscribeMarks(bump);
    const unsubFindings = subscribeFindings(bump);
    return () => {
      unsubMarks();
      unsubFindings();
    };
  }, [path]);
  return revision;
}
