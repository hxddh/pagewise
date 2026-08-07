import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { changelogSection } from "./changelog-section.mjs";

const CHANGELOG = `# Changelog

Some preamble.

## [Unreleased]

## [5.0.0] - 2026-08-04

### Added

- Marks.

## [4.4.0] - 2026-08-04

### Added

- Links.

## [4.3.0] - 2026-08-04

- Older.
`;

describe("changelogSection", () => {
  it("returns one version's body, stopping at the next version", () => {
    expect(changelogSection(CHANGELOG, "5.0.0")).toBe("### Added\n\n- Marks.");
  });

  it("reads a version in the middle of the file", () => {
    expect(changelogSection(CHANGELOG, "4.4.0")).toBe("### Added\n\n- Links.");
  });

  it("reads the last version in the file", () => {
    expect(changelogSection(CHANGELOG, "4.3.0")).toBe("- Older.");
  });

  it("does not match a version that is a prefix of another", () => {
    // "4.3" must not pick up "4.3.0" — a release would ship the wrong notes.
    expect(changelogSection(CHANGELOG, "4.3")).toBeNull();
  });

  it("treats the dot as a literal, not as any character", () => {
    expect(changelogSection(CHANGELOG, "5X0.0")).toBeNull();
  });

  it("returns null for a version with no section", () => {
    // The caller fails the release rather than publishing empty notes.
    expect(changelogSection(CHANGELOG, "9.9.9")).toBeNull();
  });

  it("returns null for a heading with an empty body", () => {
    expect(changelogSection(CHANGELOG, "Unreleased")).toBeNull();
  });

  it("keeps the real CHANGELOG's newest entry intact", () => {
    // A guard on the format itself: a restructured CHANGELOG that this can no
    // longer parse would otherwise only surface during a release.
    const real = readCurrentChangelog();
    const version = readCurrentVersion();
    const section = changelogSection(real, version);
    expect(section, `no CHANGELOG section for VERSION ${version}`).toBeTruthy();
  });

  it("gives no version two subsections of the same name", () => {
    // What a dropped version heading looks like, and the only trace it leaves.
    //
    // Adding a release by hand means writing `## [new]` above the previous
    // entry — and 7.5.3 was added by replacing the line `## [7.5.2] - ...`
    // instead of inserting above it. Nothing complained: the CHANGELOG still
    // parsed, the file still read top to bottom, and the release script still
    // found a section for the current version. It just found 7.5.2's entry
    // inside it, and published both under one version's notes.
    //
    // The signature is a version section carrying `### Fixed` twice, because
    // consecutive releases tend to use the same subsection headings. That is
    // cheap to check and does not fire on anything legitimate — a version has
    // no reason to open Fixed, close it, and open it again.
    const real = readCurrentChangelog();
    for (const version of listChangelogVersions(real)) {
      const headings = (changelogSection(real, version) ?? "")
        .split("\n")
        .filter((line) => /^###\s/.test(line));
      const seen = new Set();
      for (const heading of headings) {
        expect(
          seen.has(heading),
          `${version} has "${heading}" twice — a version heading was probably overwritten`,
        ).toBe(false);
        seen.add(heading);
      }
    }
  });

  it("lists versions newest first", () => {
    // The other half of the same mistake: an entry inserted in the wrong place.
    const versions = listChangelogVersions(readCurrentChangelog()).map((v) =>
      v.split(".").map(Number),
    );
    for (let i = 1; i < versions.length; i++) {
      expect(compareVersions(versions[i - 1], versions[i])).toBeGreaterThan(0);
    }
  });
});

function listChangelogVersions(markdown) {
  return [...markdown.matchAll(/^##\s+\[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function readCurrentChangelog() {
  return fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
}

function readCurrentVersion() {
  return fs.readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
}