interface CitationBlockProps {
  docName?: string;
  page: number;
  pageEnd?: number;
  excerpt: string;
  onGoToPage?: (page: number) => void;
}

export function CitationBlock({
  docName,
  page,
  pageEnd,
  excerpt,
  onGoToPage,
}: CitationBlockProps) {
  const pageLabel =
    pageEnd && pageEnd !== page ? `pp. ${page}–${pageEnd}` : `p. ${page}`;

  return (
    <blockquote className="citation-block">
      <div className="citation-meta">
        {docName && <span className="citation-doc">{docName}</span>}
        <button
          type="button"
          className="citation-page"
          onClick={() => onGoToPage?.(page)}
          disabled={!onGoToPage}
        >
          {pageLabel}
        </button>
      </div>
      <p className="citation-excerpt">{excerpt}</p>
    </blockquote>
  );
}
