import { describe, expect, it } from "vitest";
import { describeAnnotations, readableAnnotations } from "./pdf-annotations";

/**
 * The exact objects pdf.js returned for a real annotated PDF.
 *
 * Copied from a dump rather than invented, because `getAnnotations` is typed
 * `Array<any>` and every field below was a guess until it was measured. Three
 * of them are not what you would write from memory: `contentsObj` is an object
 * rather than a string, `quadPoints` is an object with numeric keys rather than
 * an array, and `overlaidText` — the text under a highlight — exists at all.
 */
const HIGHLIGHT = {
  annotationType: 9,
  subtype: "Highlight",
  id: "6R",
  color: { 0: 255, 1: 255, 2: 0 },
  contentsObj: { str: "Is eight weeks long enough?", dir: "ltr" },
  titleObj: { str: "Reviewer A", dir: "ltr" },
  modificationDate: "D:20260101120000Z",
  rect: [38, 714, 420, 734],
  quadPoints: { 0: 38, 1: 734, 2: 420, 3: 734, 4: 38, 5: 714, 6: 420, 7: 714 },
  overlaidText: "The trial ran for eight weeks and enrolled 240 patients.",
};

const STICKY = {
  annotationType: 1,
  subtype: "Text",
  id: "7R",
  contentsObj: { str: "Check this against table 3.", dir: "ltr" },
  titleObj: { str: "Reviewer B", dir: "ltr" },
  rect: [500, 698, 522, 720],
  name: "Comment",
};

/** A box someone drew, with nothing written on it. */
const BARE_SQUARE = {
  annotationType: 5,
  subtype: "Square",
  id: "8R",
  color: { 0: 255, 1: 0, 2: 0 },
  contentsObj: { str: "", dir: "ltr" },
  titleObj: { str: "", dir: "ltr" },
  rect: [40, 600, 300, 680],
};

describe("readableAnnotations", () => {
  it("reads the comment and the author out of the objects pdf.js actually returns", () => {
    const [a] = readableAnnotations([HIGHLIGHT], 3);
    expect(a!.contents).toBe("Is eight weeks long enough?");
    expect(a!.author).toBe("Reviewer A");
    expect(a!.page).toBe(3);
    expect(a!.subtype).toBe("Highlight");
  });

  it("carries the text a highlight covers", () => {
    // The meaning of a highlight is the sentence under it. pdf.js has already
    // done that join; without it a highlight is a coloured rectangle.
    const [a] = readableAnnotations([HIGHLIGHT], 1);
    expect(a!.quoted).toBe("The trial ran for eight weeks and enrolled 240 patients.");
  });

  it("gives a bottom-left rect, the convention links and text runs use", () => {
    // NOT the top-left convention the reader's own marks are stored in. 9.2.3
    // is what confusing the two costs: every mark drawn mirrored about the
    // middle of the page.
    const [a] = readableAnnotations([HIGHLIGHT], 1);
    expect(a!.rect).toEqual({ x: 38, y: 714, width: 382, height: 20 });
  });

  it("normalizes a rect whose corners are written the other way round", () => {
    const [a] = readableAnnotations([{ ...HIGHLIGHT, rect: [420, 734, 38, 714] }], 1);
    expect(a!.rect).toEqual({ x: 38, y: 714, width: 382, height: 20 });
  });

  it("keeps a sticky note, which has no text under it", () => {
    const [a] = readableAnnotations([STICKY], 1);
    expect(a!.contents).toBe("Check this against table 3.");
    expect(a!.quoted).toBe("");
  });

  it("drops a mark that says nothing and covers nothing", () => {
    // A coloured box with no comment means something only to whoever drew it.
    expect(readableAnnotations([BARE_SQUARE], 1)).toEqual([]);
  });

  it("drops links, popups and form fields", () => {
    // A Link is already handled as a link; a Popup is the container an existing
    // note is shown in, not a note. Carrying either double-counts.
    const noisy = [
      { subtype: "Link", contentsObj: { str: "x" }, rect: [0, 0, 10, 10] },
      { subtype: "Popup", contentsObj: { str: "x" }, rect: [0, 0, 10, 10] },
      { subtype: "Widget", contentsObj: { str: "x" }, rect: [0, 0, 10, 10] },
    ];
    expect(readableAnnotations(noisy, 1)).toEqual([]);
  });

  it("survives a rect that is degenerate or missing", () => {
    expect(readableAnnotations([{ ...STICKY, rect: [10, 10, 10, 10] }], 1)).toEqual([]);
    expect(readableAnnotations([{ ...STICKY, rect: undefined }], 1)).toEqual([]);
    expect(readableAnnotations([{ ...STICKY, rect: [1, 2] }], 1)).toEqual([]);
  });

  it("survives junk in the array without losing what was good", () => {
    const out = readableAnnotations([null, 42, "x", HIGHLIGHT, undefined], 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("6R");
  });

  it("bounds a comment that is really an essay", () => {
    const long = { ...STICKY, contentsObj: { str: "x".repeat(5000) } };
    expect(readableAnnotations([long], 1)[0]!.contents.length).toBeLessThanOrEqual(600);
  });
});

describe("describeAnnotations", () => {
  it("puts the page first, then who said it, then what they said", () => {
    const notes = readableAnnotations([HIGHLIGHT, STICKY], 4);
    const { lines } = describeAnnotations(notes);
    expect(lines[0]).toContain("p4");
    expect(lines[0]).toContain("Reviewer A");
    expect(lines[0]).toContain("Is eight weeks long enough?");
    expect(lines[0]).toContain("The trial ran for eight weeks");
  });

  it("stays inside its budget and says what it left out", () => {
    // A heavily reviewed PDF carries hundreds of comments. Sending them all
    // would cost more than the pages the question is about.
    const many = Array.from({ length: 300 }, (_, i) =>
      readableAnnotations([{ ...STICKY, id: `n${i}`, contentsObj: { str: `Comment number ${i}` } }], 1)[0]!,
    );
    const { lines, omitted } = describeAnnotations(many, 1_000);
    expect(lines.join("\n").length).toBeLessThanOrEqual(1_000);
    expect(omitted).toBeGreaterThan(0);
    expect(lines.length + omitted).toBe(300);
  });

  it("says nothing at all when the document carries no notes", () => {
    expect(describeAnnotations([]).lines).toEqual([]);
  });
});
