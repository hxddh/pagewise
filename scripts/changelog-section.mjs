#!/usr/bin/env node
/**
 * Print the CHANGELOG section for a version, for use as the release body.
 *
 * Without this the release page carries only GitHub's generated "What's
 * Changed" line — the pull request title and nothing else. Everything the
 * CHANGELOG says about a version stayed in the repository, where nobody
 * downloading a build would look.
 *
 * Usage: node scripts/changelog-section.mjs [version] > notes.md
 * The version defaults to the VERSION file.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The body of `## [version]` up to the next `##` heading.
 *
 * Returns null when the version has no section, which the caller treats as an
 * error: shipping a release whose notes are silently empty is the thing this
 * script exists to prevent.
 */
export function changelogSection(markdown, version) {
  const lines = markdown.split("\n");
  // "## [5.0.0] - 2026-08-04" — the date is optional and not captured; the
  // release page already shows when it was published.
  const heading = new RegExp(`^##\\s+\\[${version.replace(/\./g, "\\.")}\\]`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;

  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    body.push(line);
  }
  const text = body.join("\n").trim();
  return text.length > 0 ? text : null;
}

// Importing this module (the test does) must not read files or exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const version = process.argv[2] || readFileSync(join(root, "VERSION"), "utf8").trim();
  const markdown = readFileSync(join(root, "CHANGELOG.md"), "utf8");

  const section = changelogSection(markdown, version);
  if (!section) {
    console.error(
      `No CHANGELOG section for ${version}. Add a "## [${version}]" entry before releasing.`,
    );
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
}
