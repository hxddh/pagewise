import { useEffect, useState } from "react";
import { getPageIndexState, subscribePageIndex, type PageIndexState } from "../lib/index-events";

export function usePageIndexStatus(path: string | null, page: number): PageIndexState | undefined {
  const [state, setState] = useState<PageIndexState | undefined>(() =>
    path ? getPageIndexState(path, page) : undefined,
  );

  useEffect(() => {
    if (!path) {
      setState(undefined);
      return;
    }
    setState(getPageIndexState(path, page));
    return subscribePageIndex((next) => {
      if (next.path === path && next.page === page) setState(next);
    });
  }, [path, page]);

  return state;
}
