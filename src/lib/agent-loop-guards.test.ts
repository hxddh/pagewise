import { describe, expect, it } from "vitest";
import {
  countToolCalls,
  getBlockedMetaTools,
  isDsmlToolLeak,
  isMetaToolOnlyLoop,
  shouldForceReadTools,
  stripDsmlToolMarkup,
} from "./agent-loop-guards";

describe("agent-loop-guards", () => {
  it("detects meta-tool-only loops", () => {
    const steps = [
      { toolCalls: [{ toolName: "get_document_index" }] },
      { toolCalls: [{ toolName: "list_documents" }] },
      { toolCalls: [{ toolName: "search_in_document" }] },
    ];
    expect(isMetaToolOnlyLoop(steps)).toBe(true);
    expect(shouldForceReadTools(steps)).toBe(true);
  });

  it("does not flag loops after a read tool ran", () => {
    const steps = [
      { toolCalls: [{ toolName: "search_in_document" }] },
      { toolCalls: [{ toolName: "read_pdf_page" }] },
      { toolCalls: [{ toolName: "search_in_document" }] },
    ];
    expect(isMetaToolOnlyLoop(steps)).toBe(false);
    expect(shouldForceReadTools(steps)).toBe(false);
  });

  it("blocks one-time meta tools after first use", () => {
    const steps = [{ toolCalls: [{ toolName: "get_document_index" }] }];
    expect(getBlockedMetaTools(steps)).toEqual(["get_document_index"]);
    expect(countToolCalls(steps, "get_document_index")).toBe(1);
  });

  it("strips DSML tool markup from displayed text", () => {
    const raw =
      '让我先读取整份文档\n<|DSML|tool_calls><|DSML|invoke name="list_documents"></|DSML|invoke></|DSML|tool_calls>';
    expect(isDsmlToolLeak(raw)).toBe(true);
    expect(stripDsmlToolMarkup(raw)).toBe("让我先读取整份文档");
  });

  it("does not truncate legitimate prose mentioning DSML and invoke name=", () => {
    // Both "DSML" and "invoke name=" appear, but only as independent substrings
    // in explanatory text — not the real `<|DSML|invoke name=` delimiter.
    const legit =
      "The DSML format is a leaked markup where a model writes <invoke name=\"foo\"> " +
      "instead of using the native tool API. We strip it so users never see it.";
    expect(isDsmlToolLeak(legit)).toBe(false);
    expect(stripDsmlToolMarkup(legit)).toBe(legit);
  });
});
