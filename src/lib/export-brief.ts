/**
 * The record, as something to take away.
 *
 * Four things could leave PageWise before 12.0: the chat, a summary of its
 * last answer, the document's text, and the reader's marks. The record — the
 * one thing the app builds up across questions — could not. The 11.0 review
 * put it plainly: the reader's work stayed in a filtered list, and turning it
 * into a briefing meant reopening the chat and copying by hand.
 *
 * A brief is the record filed by trust. What the reader vouched for and what
 * the page confirmed are conclusions; the wording each rests on is evidence;
 * what the file changed under, what the page did not carry, and what had
 * nothing to check against are listed to re-check, with the reason. Retracted
 * entries are not in it: a brief is what stands, not the history of what did.
 *
 * Every page reference is the printed number when the document has one, with
 * the sheet count behind it — the same rule the toolbar follows — so a page
 * named here is a page the reader can turn to in any viewer.
 */
import { citationsToText } from "./citations";
import { cachedCitationCheck } from "./citation-check";
import { cachedReview, reviewBasis, type ReviewVerdict } from "./claim-review";
import type { Finding } from "./finding-store";
import { labelForPage } from "./page-labels";
import { TRUST_KNOWN, type Trust } from "./finding-trust";
import { briefReasons, reviewReasons } from "./trust-text";
import type { LoadedDocument } from "./types";

export interface BriefEntry {
  finding: Finding;
  trust: Trust;
}

/**
 * The headings and phrases, so the file reads in the reader's language. The
 * reason lines come from `trust-text.ts` — the same table the chip, the
 * record and the CSV read — so the brief cannot say a state the app does not.
 */
export interface BriefLabels {
  title: string;
  document: string;
  exported: string;
  pages: string;
  conclusions: string;
  evidence: string;
  toRecheck: string;
  nothingHere: string;
  page: (ref: string) => string;
  trust: Record<Exclude<Trust, "retracted">, string>;
  /**
   * The model's reading of a claim, where the reader asked for one (20.0).
   * Labelled as the model's — the same `cite.review.*` words the chip shows —
   * because the brief files local checks and a model's verdict side by side
   * and they must never be read as one another.
   */
  review: Record<ReviewVerdict, string>;
  keptFromAnswer: string;
}

export const BRIEF_LABELS_EN: BriefLabels = {
  title: "Brief",
  document: "Document",
  exported: "Exported",
  pages: "pages",
  conclusions: "Conclusions",
  evidence: "Evidence",
  toRecheck: "To re-check",
  nothingHere: "Nothing yet.",
  page: (ref) => `p. ${ref}`,
  trust: briefReasons("en"),
  review: reviewReasons("en"),
  keptFromAnswer: "Kept from an answer",
};

export const BRIEF_LABELS_ZH: BriefLabels = {
  title: "阅读简报",
  document: "文档",
  exported: "导出时间",
  pages: "页",
  conclusions: "结论",
  evidence: "依据",
  toRecheck: "待复核",
  nothingHere: "暂无。",
  page: (ref) => `第 ${ref} 页`,
  trust: briefReasons("zh-CN"),
  review: reviewReasons("zh-CN"),
  keptFromAnswer: "留自一条回答",
};

/** "47" for an ordinary page; "xii (sheet 12)" when the printed number differs. */
export function pageRef(doc: Pick<LoadedDocument, "pageLabels">, page: number): string {
  const label = labelForPage(doc.pageLabels ?? null, page);
  return label ? `${label} (sheet ${page})` : String(page);
}

function pagesRef(doc: Pick<LoadedDocument, "pageLabels">, pages: readonly number[]): string {
  return pages.map((p) => pageRef(doc, p)).join(", ");
}

/** A quote as a Markdown blockquote, one line per source line. */
function quote(text: string): string[] {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`);
}

/**
 * The model's verdict on an entry, where the reader asked for one and this
 * session still holds it — the labelled line from `cite.review.*`, appended
 * beside the local reason. The review is keyed by the claim and the quote the
 * answer's chip read; a kept entry carries both, so the common case matches
 * exactly, and an entry whose claim is a whole answer's summary simply files
 * no verdict. Nothing is guessed from a near match.
 */
function reviewLine(doc: LoadedDocument, finding: Finding, labels: BriefLabels): string {
  const evidence = finding.evidence.trim();
  if (!evidence) return "";
  // Read against the passage the entry's check finds now (22.0): a verdict
  // on words the page no longer has is not filed.
  const basis = reviewBasis(cachedCitationCheck(doc.path, { pages: finding.pages, quote: evidence }));
  const review = cachedReview(doc.path, finding.claim, evidence, basis);
  return review ? ` · _${labels.review[review.verdict]}_` : "";
}

/**
 * The brief.
 *
 * Entries are numbered once, in the order they were written, and the number
 * is reused in the evidence section so a quote can be matched to its claim
 * without the file being read twice.
 */
export function briefToMarkdown(
  doc: LoadedDocument,
  entries: readonly BriefEntry[],
  labels: BriefLabels = BRIEF_LABELS_EN,
  now: Date = new Date(),
): string {
  const heading = doc.title?.trim() || doc.name;
  const standing = entries.filter((e) => e.trust !== "retracted");
  const conclusions = standing.filter((e) => TRUST_KNOWN.has(e.trust) && e.trust !== "unverified");
  const toRecheck = standing.filter((e) => !conclusions.includes(e));
  const numberOf = new Map(standing.map((e, i) => [e.finding.id, i + 1] as const));

  const lines: string[] = [`# ${heading} — ${labels.title}`, ""];
  lines.push(
    `**${labels.document}:** ${doc.name} · ${doc.totalPages} ${labels.pages}` +
      (doc.stamp ? ` · ${doc.stamp}` : ""),
    `**${labels.exported}:** ${now.toLocaleString()}`,
    "",
    "---",
    "",
  );

  lines.push(`## ${labels.conclusions}`, "");
  if (conclusions.length === 0) lines.push(labels.nothingHere, "");
  for (const { finding, trust } of conclusions) {
    const n = numberOf.get(finding.id)!;
    const reason = labels.trust[trust as Exclude<Trust, "retracted">];
    lines.push(
      `${n}. ${finding.claim} — ${labels.page(pagesRef(doc, finding.pages))} · _${reason}_${reviewLine(doc, finding, labels)}`,
    );
    if (finding.body) {
      lines.push("", `   _${labels.keptFromAnswer}:_`, "");
      for (const line of citationsToText(finding.body).split(/\r?\n/)) lines.push(line ? `   ${line}` : "");
    }
    lines.push("");
  }

  lines.push(`## ${labels.evidence}`, "");
  const withEvidence = conclusions.filter((e) => e.finding.evidence.trim());
  if (withEvidence.length === 0) lines.push(labels.nothingHere, "");
  for (const { finding } of withEvidence) {
    const n = numberOf.get(finding.id)!;
    lines.push(`**${n}.** ${labels.page(pagesRef(doc, finding.pages))}`, "");
    lines.push(...quote(finding.evidence), "");
  }

  lines.push(`## ${labels.toRecheck}`, "");
  if (toRecheck.length === 0) lines.push(labels.nothingHere, "");
  for (const { finding, trust } of toRecheck) {
    const n = numberOf.get(finding.id)!;
    const reason = labels.trust[trust as Exclude<Trust, "retracted">];
    lines.push(
      `${n}. ${finding.claim} — ${labels.page(pagesRef(doc, finding.pages))} · _${reason}_${reviewLine(doc, finding, labels)}`,
    );
    if (finding.evidence.trim()) lines.push("", ...quote(finding.evidence).map((l) => `   ${l}`));
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
