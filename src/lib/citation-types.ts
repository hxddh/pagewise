/** Legacy structured citation shape (v2 chats only; v3 no longer generates these). */
export interface StructuredCitation {
  page: number;
  pageEnd?: number;
  quote: string;
}
