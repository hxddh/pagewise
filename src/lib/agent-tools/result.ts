import type { PageLink } from "../page-links";

/**
 * What a read puts into the model's context.
 *
 * There was no shared shape: six tools assembled objects at thirty-one separate
 * `return {` sites, with nineteen kinds of field on one and one on another. That
 * is not a tidiness complaint — it is why two problems went unnoticed for
 * several releases. The survey was sending 1,273 tokens of per-page character
 * counts, and five standing notes were being resent per call, and nothing in
 * the codebase showed, in one place, what the tools actually put into the
 * context. A type does.
 *
 * The rule this encodes: a result carries **what was read** and **what was
 * found beside it**, and nothing that says the same thing every time. Standing
 * instructions belong in the system prompt, where they are sent once and land
 * inside the cached prefix. Only text that genuinely varies with the situation
 * — a quota reached, a page that changed under a read — rides along here.
 */

/** A passage the reader singled out, carried beside the page it sits on. */
export interface MarkAttachment {
  page: number;
  text: string;
  note?: string;
}

/**
 * Things found beside the text, which the text itself does not contain.
 *
 * Each is explained once in the system prompt. Nothing here carries prose.
 */
export interface ReadAttachments {
  /** Hyperlink destinations; they live in the PDF's annotations, not the text. */
  links?: PageLink[];
  /** Passages the reader marked, with their notes. Read-only. */
  marks?: MarkAttachment[];
}

/** The common shape of every tool that returns document text. */
export interface ReadResult extends ReadAttachments {
  text: string;
  /** Set by the single-page reader; ranges report `nextStart` instead. */
  page?: number;
  /** Where the text came from — extracted, or a billed vision pass. */
  source?: "cache" | "vision";
  /** True when the caller must ask again to see the rest. */
  truncated: boolean;
  /** Resume point within a page, or null when the page is complete. */
  nextOffset: number | null;
  /** Resume point across a range, or null when the range is complete. */
  nextStart?: number | null;
  charCount: number;

  /* Range readers report which pages they actually covered. */
  startPage?: number;
  endPage?: number;
  /** What the caller asked for, when the document was shorter than that. */
  requestedEnd?: number;
  actualEnd?: number;
  rangeClamped?: boolean;
  /** Pages inside the range that could not be indexed, as compressed ranges. */
  indexingFailedPages?: string;
  /** Pages skipped because the scan allowance ran out. */
  unscannedPages?: string;
  /** The section a read resolved to, when it was reached by name. */
  section?: string;
  /** The read stopped because the turn's budget ran out. */
  budgetExceeded?: boolean;
  /** The page had no text layer and the scan allowance is spent. */
  scanLimitReached?: boolean;
  /** Indexing failed for this page — not the same as the page being empty. */
  indexingFailed?: boolean;
  /** This page was already returned in full earlier in the turn. */
  alreadyRead?: boolean;
  /**
   * Situational text only. If a sentence would read the same on every call, it
   * belongs in the system prompt instead — that is the mistake this field
   * exists to make visible.
   */
  note?: string;
}
