import { describe, expect, it } from "vitest";
import {
  countToolCalls,
  getBlockedMetaTools,
  isDsmlToolLeak,
  isDsmlOnlyAssistantText,
  isMetaToolOnlyLoop,
  shouldForceReadTools,
  stripDsmlToolMarkup,
} from "./agent-loop-guards";
import { DOCUMENT_OUTLINE_TOOL } from "./document-tool-names";

describe("agent-loop-guards", () => {
  it("detects meta-tool-only loops", () => {
    const steps = [
      { toolCalls: [{ toolName: DOCUMENT_OUTLINE_TOOL }] },
      { toolCalls: [{ toolName: DOCUMENT_OUTLINE_TOOL }] },
      { toolCalls: [{ toolName: "search_in_document" }] },
    ];
    expect(isMetaToolOnlyLoop(steps)).toBe(true);
    expect(shouldForceReadTools(steps)).toBe(true);
  });

  it("detects an imminent meta-loop one step early with window=2 (synthesis nudge)", () => {
    // Two identical outline calls back-to-back: window=2 flags the spin before a
    // third call would trip the window=3 stop, so prepareStep can force an answer.
    const steps = [
      { toolCalls: [{ toolName: DOCUMENT_OUTLINE_TOOL }] },
      { toolCalls: [{ toolName: DOCUMENT_OUTLINE_TOOL }] },
    ];
    expect(isMetaToolOnlyLoop(steps, 2)).toBe(true);
    expect(isMetaToolOnlyLoop(steps)).toBe(false); // default window=3 not yet
  });

  it("window=2 does not flag two DISTINCT meta calls (progress, not a spin)", () => {
    const steps = [
      { toolCalls: [{ toolName: "search_in_document", input: { query: "a" } }] },
      { toolCalls: [{ toolName: "search_in_document", input: { query: "b" } }] },
    ];
    expect(isMetaToolOnlyLoop(steps, 2)).toBe(false);
  });

  it("does not flag when a recent read interrupts the meta calls", () => {
    const steps = [
      { toolCalls: [{ toolName: "search_in_document" }] },
      { toolCalls: [{ toolName: "read_pdf_page" }] },
      { toolCalls: [{ toolName: "search_in_document" }] },
    ];
    // The read is within the last `window` steps, so the window is not meta-only.
    expect(isMetaToolOnlyLoop(steps)).toBe(false);
    expect(shouldForceReadTools(steps)).toBe(false);
  });

  it("flags a repeated meta call even when a read happened earlier in the run (N4)", () => {
    const steps = [
      { toolCalls: [{ toolName: "read_pdf_page" }] }, // early read, then spin
      { toolCalls: [{ toolName: DOCUMENT_OUTLINE_TOOL }] },
      { toolCalls: [{ toolName: "search_in_document", input: { query: "x" } }] },
      { toolCalls: [{ toolName: DOCUMENT_OUTLINE_TOOL }] }, // outline repeats → spin
    ];
    expect(isMetaToolOnlyLoop(steps)).toBe(true);
  });

  it("flags the same search issued repeatedly", () => {
    const steps = [
      { toolCalls: [{ toolName: "search_in_document", input: { query: "a" } }] },
      { toolCalls: [{ toolName: "search_in_document", input: { query: "a" } }] },
      { toolCalls: [{ toolName: "search_in_document", input: { query: "a" } }] },
    ];
    expect(isMetaToolOnlyLoop(steps)).toBe(true);
  });

  it("does NOT flag distinct refined searches (progress, not a loop)", () => {
    const steps = [
      { toolCalls: [{ toolName: "read_pdf_page" }] },
      { toolCalls: [{ toolName: "search_in_document", input: { query: "a" } }] },
      { toolCalls: [{ toolName: "search_in_document", input: { query: "b" } }] },
      { toolCalls: [{ toolName: "search_in_document", input: { query: "c" } }] },
    ];
    // Last 3 are all searches but with distinct queries → the model is making
    // progress locating passages, not spinning. Must not be stopped.
    expect(isMetaToolOnlyLoop(steps)).toBe(false);
  });

  it("does not flag when the latest step produced text instead of a tool call", () => {
    const steps = [
      { toolCalls: [{ toolName: DOCUMENT_OUTLINE_TOOL }] },
      { toolCalls: [{ toolName: "search_in_document" }] },
      { text: "Here is the answer." },
    ];
    expect(isMetaToolOnlyLoop(steps)).toBe(false);
  });

  it("blocks one-time meta tools after first use", () => {
    const steps = [{ toolCalls: [{ toolName: DOCUMENT_OUTLINE_TOOL }] }];
    expect(getBlockedMetaTools(steps)).toEqual([DOCUMENT_OUTLINE_TOOL]);
    expect(countToolCalls(steps, DOCUMENT_OUTLINE_TOOL)).toBe(1);
  });

  it("strips DSML tool markup from displayed text", () => {
    const raw =
      '让我先读取整份文档\n<|DSML|tool_calls><|DSML|invoke name="list_documents"></|DSML|invoke></|DSML|tool_calls>';
    expect(isDsmlToolLeak(raw)).toBe(true);
    expect(stripDsmlToolMarkup(raw)).toBe("让我先读取整份文档");
  });

  it("strips spaced-pipe DSML markup (DeepSeek tokenization)", () => {
    const raw =
      '< | | DSML | | tool_calls> < | | DSML | | invoke name="list_documents">\n</ | | DSML | | invoke></ | | DSML | | tool_calls>';
    expect(isDsmlToolLeak(raw)).toBe(true);
    expect(stripDsmlToolMarkup(raw)).toBe("");
    expect(isDsmlOnlyAssistantText(raw)).toBe(true);
  });

  it("does not truncate legitimate prose mentioning DSML and invoke name=", () => {
    const legit =
      "The DSML format is a leaked markup where a model writes " +
      "instead of using the native tool API. We strip it so users never see it.";
    expect(isDsmlToolLeak(legit)).toBe(false);
    expect(stripDsmlToolMarkup(legit)).toBe(legit);
  });
});
