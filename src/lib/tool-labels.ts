export function friendlyToolLabel(
  toolName: string,
  input?: unknown,
): string {
  const inp =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  switch (toolName) {
    case "read_pdf_page":
      return typeof inp.page === "number" ? `Read page ${inp.page}` : "Read page";
    case "read_pdf_range": {
      const start = inp.start;
      const end = inp.end;
      if (typeof start === "number" && typeof end === "number") {
        return start === end ? `Read page ${start}` : `Read pages ${start}–${end}`;
      }
      return "Read pages";
    }
    case "search_in_document":
      return typeof inp.query === "string"
        ? `Search “${truncate(inp.query, 40)}”`
        : "Search document";
    case "list_documents":
      return "List documents";
    case "ocr_file":
      return "Run OCR";
    default:
      return toolName.replace(/_/g, " ");
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

export function toolStateSummary(state: string): string {
  switch (state) {
    case "input-streaming":
    case "input-available":
      return "Running";
    case "output-available":
      return "Done";
    case "output-error":
      return "Failed";
    default:
      return state;
  }
}
