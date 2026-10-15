/**
 * "Report a problem" (v23): a GitHub issue, pre-filled, opened in the
 * reader's browser.
 *
 * 101 releases had 76 downloads and no issue, and the app had no way to say
 * anything back (docs/reviews/2026-10-15-pagewise-v23-evaluation.md §2.2).
 * This is the way back, and only that: what the link carries is the version,
 * the platform and the interface language — never a document's name, path or
 * text — and nothing is sent unless the reader submits the issue themselves.
 * There is no telemetry.
 */
export const ISSUES_URL = "https://github.com/hxddh/pagewise/issues/new";

export interface IssueContext {
  version: string;
  /** e.g. "macOS", "Windows", "Linux". */
  platform: string;
  locale: string;
}

/** The OS family from the user agent — the family only, never the full string. */
export function platformName(userAgent: string): string {
  if (/Mac OS X|Macintosh/i.test(userAgent)) return "macOS";
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/Linux|X11/i.test(userAgent)) return "Linux";
  return "unknown";
}

export function issueUrl({ version, platform, locale }: IssueContext): string {
  const body = [
    "**What happened**",
    "",
    "",
    "**What you expected**",
    "",
    "",
    "**Steps** (please leave out anything private in the document)",
    "",
    "",
    "---",
    `PageWise ${version} · ${platform} · ${locale}`,
  ].join("\n");
  const params = new URLSearchParams({ template: "bug_report.md", body });
  return `${ISSUES_URL}?${params.toString()}`;
}
