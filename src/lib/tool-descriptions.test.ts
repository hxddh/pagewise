import { describe, expect, it } from "vitest";
import {
  createDocumentTools,
  newReadBudget,
  DEFAULT_PAGE_MAX_CHARS,
  DEFAULT_RANGE_MAX_CHARS,
  DEFAULT_SEARCH_HITS,
  DEFAULT_FIGURE_INDEX,
} from "./agent";

/**
 * What a tool says its default is, and what it actually does.
 *
 * 7.1 lowered the search default from 50 hits to 12 and left the parameter
 * still documenting 50. The model reads the description and nothing else — a
 * stale number there is not a comment that went out of date, it is a false
 * statement in the prompt, and it changes what the model decides to pass.
 *
 * The drift-proof way to write these is either to interpolate the constant or
 * to name the parameter without a number ("capped at maxChars"). This asserts
 * that every number actually written is a live default.
 */

const tools = createDocumentTools(newReadBudget());

/**
 * Everything a model reads about a tool: its own description AND every
 * parameter's. The stale "default 50" lived on the parameter, so a check that
 * only looked at the tool description would have passed right through it.
 */
function prose(name: keyof typeof tools): string {
  const tool = tools[name] as {
    description?: string;
    inputSchema?: { shape?: Record<string, { description?: string }> };
  };
  const params = Object.values(tool.inputSchema?.shape ?? {})
    .map((p) => p.description ?? "")
    .join(" ");
  return `${tool.description ?? ""} ${params}`;
}

describe("a tool's stated default is its real default", () => {
  it("search states the hit count it actually returns", () => {
    expect(prose("search_in_document")).toContain(String(DEFAULT_SEARCH_HITS));
    // What it claimed instead, for four releases.
    expect(prose("search_in_document")).not.toContain("default 50");
  });

  it("no description states a default that is not a live constant", () => {
    const live = new Set([
      String(DEFAULT_PAGE_MAX_CHARS),
      String(DEFAULT_RANGE_MAX_CHARS),
      String(DEFAULT_SEARCH_HITS),
      String(DEFAULT_FIGURE_INDEX),
    ]);
    for (const name of Object.keys(tools) as (keyof typeof tools)[]) {
      for (const [, n] of prose(name).matchAll(/default\s+([\d,]+)/gi)) {
        expect(live, `${String(name)} documents a default of ${n}`).toContain(
          n.replace(/,/g, ""),
        );
      }
    }
  });

  it("the range reader interpolates its cap rather than spelling it out", () => {
    expect(prose("read_pdf_range")).toContain(String(DEFAULT_RANGE_MAX_CHARS));
  });
});
