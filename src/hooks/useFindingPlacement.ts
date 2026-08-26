import { useEffect, useState } from "react";
import { placeFinding, type FindingPlacement } from "../lib/finding-anchors";
import type { Finding } from "../lib/finding-store";

/**
 * Whether this claim's evidence is really on the page it cites.
 *
 * Resolved rather than stored, and resolved here rather than in the panel's
 * render, because `placeFinding` reads the page's text runs over IPC. The
 * answer starts as null — "not looked yet" — so nothing is ever drawn as
 * doubtful merely because the lookup has not come back.
 *
 * That distinction is the whole point. A badge that said "not found" while
 * still loading would accuse the assistant of fabricating a quote once per
 * render, and a reader who sees that warning falsely twice will stop reading it
 * the time it is true.
 */
export function useFindingPlacement(path: string, finding: Finding): FindingPlacement | null {
  const [placement, setPlacement] = useState<FindingPlacement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPlacement(null);
    void placeFinding(path, finding).then(
      (result) => {
        if (!cancelled) setPlacement(result);
      },
      () => {
        // Unreadable page runs are not evidence of a bad quote.
        if (!cancelled) setPlacement({ status: "uncheckable" });
      },
    );
    return () => {
      cancelled = true;
    };
    // The id and the wording are what a placement depends on; the finding
    // object itself is rebuilt by the store on every unrelated mutation.
  }, [path, finding.id, finding.evidence, finding.pages.join(",")]);

  return placement;
}
