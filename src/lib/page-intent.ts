/** User refers to the page currently open in the preview. */
export function hasCurrentPageIntent(text: string): boolean {
  return /这一页|当前页|本页|此页|这页|this page|current page|the page (?:i'?m|I'?m|I'm) (?:viewing|on|reading)/i.test(
    text,
  );
}

/** User wants the whole document, not a single page. */
export function hasWholeDocumentIntent(text: string): boolean {
  return /全文|整份|整个文档|整篇|所有页|全书|whole document|entire document|full document|all pages|document summary|总结(?:一下)?(?:这份|这个|整|全)|分析(?:一下)?(?:这份|这个|整|全)/i.test(
    text,
  );
}

export function extractExplicitPageNumbers(text: string): number[] {
  const found = new Set<number>();
  const patterns = [
    /第\s*(\d{1,4})\s*页/g,
    /page\s*(\d{1,4})/gi,
    /\bp\.\s*(\d{1,4})\b/gi,
    /\bp\s*(\d{1,4})\b/gi,
  ];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const n = parseInt(match[1]!, 10);
      if (Number.isFinite(n) && n > 0) found.add(n);
    }
  }
  return [...found];
}

export interface FollowPageContext {
  userText: string;
  viewingPage: number;
}

/** Whether follow-agent should jump preview to a page the agent just read. */
export function shouldFollowAgentToPage(
  readPage: number,
  ctx: FollowPageContext | null,
): boolean {
  if (!ctx) return true;

  const { userText, viewingPage } = ctx;

  if (hasWholeDocumentIntent(userText)) return false;

  if (hasCurrentPageIntent(userText)) {
    return readPage === viewingPage;
  }

  if (extractExplicitPageNumbers(userText).length > 0) {
    return false;
  }

  return readPage === viewingPage;
}
