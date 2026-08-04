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
});

function readCurrentChangelog() {
  return fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
}

function readCurrentVersion() {
  return fs.readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
}