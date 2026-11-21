import {
  ToolLoopAgent,
  stepCountIs,
  InvalidToolInputError,
  type Instructions,
  type StopCondition,
  type ToolCallRepairFunction,
} from "ai";
import {
  buildDocToolContext,
  buildRuntimeContext,
  type PageWiseRuntimeContext,
} from "./agent-runtime-context";
import {
  appendContextToLastUserMessage,
  buildDocumentMapInstructions,
  buildViewContextInstructions,
  buildWholeDocumentInstructions,
} from "./agent-view-context";
import { AGENT_TIMEOUT } from "./agent-timeouts";
import { buildRecordInstructions } from "./agent-record-context";
import { buildCitationFeedback } from "./agent-citation-context";
import { labelHintFor } from "./agent-label-context";
import { compactRunMessages, KEEP_RECENT_CHARS } from "./compact-run-messages";
import {
  beginSteerRun,
  hasSynthesisMaterial,
  withSteerMessage,
  type StepLike,
} from "./agent-steer";
import { resolveModel, resolveReasoning } from "./llm";
import { runKeepRecentChars, runTokenBudget } from "./model-capabilities";
import { hasWholeDocumentIntent } from "./page-intent";
import { loadSettings } from "./settings";
import { getAgentScanCap } from "../document/index-queue";
import { DEFAULT_SETTINGS, type LlmSettings } from "./types";
import { isMetaToolOnlyLoop } from "./agent-loop-guards";
import { coerceNumericToolInput, normalizeRangeInput } from "./agent-tool-repair";
import {
  DOCUMENT_OUTLINE_TOOL,
  READ_FIGURE_TOOL,
  READ_PDF_PAGE_TOOL,
  READ_PDF_RANGE_TOOL,
  READ_SECTION_TOOL,
  SEARCH_IN_DOCUMENT_TOOL,
  NOTE_FINDING_TOOL,
  REVISE_FINDING_TOOL,
  type DocumentToolName,
} from "./document-tool-names";
import {
  createDocumentTools,
  newReadBudget,
} from "./agent-tools";
import { forgetDelivered } from "./agent-tools/reading";

export {
  createAgentTools,
  createDocumentTools,
  newReadBudget,
  compressPageRanges,
  DEFAULT_PAGE_MAX_CHARS,
  DEFAULT_RANGE_MAX_CHARS,
  DEFAULT_SEARCH_HITS,
  DEFAULT_FIGURE_INDEX,
  MAX_FREE_REREADS,
  type ReadBudget,
} from "./agent-tools";


/**
 * Step budget floor for every run. NOT gated on any intent heuristic — a broad
 * question phrased outside the whole-document keyword set ("review every
 * section", "what recurs across the paper") gets the same room as one that
 * matches. The cumulative read budget is the real cost rail; a targeted
 * question self-terminates well under this.
 */
const DEFAULT_MAX_AGENT_STEPS = 20;
/** Hard ceiling, so a runaway can't chain unbounded tool calls. */
const MAX_WHOLEDOC_STEPS = 30;

/** Step budget for a run: scales with page count (bounded), regardless of intent. */
export function resolveRunMaxSteps(totalPages: number): number {
  return Math.min(MAX_WHOLEDOC_STEPS, Math.max(DEFAULT_MAX_AGENT_STEPS, totalPages || 0));
}

/** Map SDK steps to the snapshot shape the meta-loop guard consumes. */
function toMetaLoopSnapshot(steps: ReadonlyArray<{ toolCalls: ReadonlyArray<unknown> }>) {
  return steps.map((step) => ({
    toolCalls: step.toolCalls.map((call) => ({
      toolName: (call as { toolName?: string }).toolName,
      input: (call as { input?: unknown }).input,
    })),
  }));
}

const stopMetaToolLoop: StopCondition<any, any> = ({ steps }) =>
  isMetaToolOnlyLoop(toMetaLoopSnapshot(steps));

/**
 * When a run stops: its step budget, or a loop of meta tools. One function,
 * used by the constructor's default and by `prepareCall`'s per-run budget —
 * the two were written out separately until 21.0, so changing the rule meant
 * changing it twice, and a test of the default would not see the run's.
 */
function stopWhenFor(maxSteps: number): StopCondition<any, any>[] {
  return [stepCountIs(maxSteps), stopMetaToolLoop];
}

/**
 * Ceiling on one reply. Generous — a synthesis over twenty pages is long — but
 * a generation that runs away is otherwise unbounded in both cost and wait.
 */
const MAX_OUTPUT_TOKENS = 8_000;

/** Retries of one step whose stream failed partway. See `streamRetries` below. */
export const STREAM_RETRIES = 1;

/**
 * Reasoning effort for the steps that only fetch. Deliberation is billed output
 * and "read page 14 next" does not need any; the step that has to turn twelve
 * pages into an answer does, and gets the configured level back.
 */
const MECHANICAL_STEP_REASONING = "low" as const;

export function stepReasoning<R>(
  runReasoning: R | undefined,
  materialOrSteps: boolean | ReadonlyArray<StepLike>,
): R | typeof MECHANICAL_STEP_REASONING | undefined {
  if (!runReasoning) return undefined;
  const hasMaterial =
    typeof materialOrSteps === "boolean"
      ? materialOrSteps
      : hasSynthesisMaterial(materialOrSteps);
  return hasMaterial ? runReasoning : MECHANICAL_STEP_REASONING;
}

export const SYSTEM_INSTRUCTIONS = `You are PageWise, a local desktop PDF assistant.

Rules:
- Read with tools; never invent page text. Cite pages for document facts, then explain and synthesize freely — add background knowledge where it helps, but keep clear what is from the document and what is not.
- Scanned pages are read by local OCR, or by a vision model where that fails — wait for results. OCR-recognised text may misread characters: quote it exactly as given, since citations are checked against it.
- Pick tools freely: search_in_document locates a term, read_pdf_page / read_pdf_range read pages, document_outline surveys structure. Search is usually the fastest start for a keyword, an outline for a broad task; read directly when that is more direct.
- If search returns nothing useful, read the pages anyway — a figure or scanned page defeats search; "no hits" is not evidence of absence. Pages reported as unindexed have no text yet, so search cannot match them: reading one reads it on demand, locally or by a billed vision call within a per-question allowance. Read only what you need, and say so if the allowance runs out.
- When the user asks about a term or topic while viewing a page, read that page first — it is usually what they mean; for an ambiguous term (e.g. an acronym), read where it appears rather than guessing.
- If a page doesn't fully answer, read on or search again; don't answer a document-spanning question from one page.
- Cite every document fact right after it with a marker: 〔p12 "words copied exactly from page 12"〕 — the page number as the tools number it, and a short quote (a phrase to one sentence) copied verbatim from the page text, punctuation included. PageWise shows the reader whether the quote is on that page: never quote from memory, never paraphrase or translate inside the quotes, never join words from different places. Spanning pages: 〔p12-13 "words spanning pages 12–13"〕. A figure or chart you cannot quote: 〔p12〕. No marker on your own reasoning or background knowledge.
- When the user asks to list, extract, compare or tabulate things across the document (every payment term, all deadlines), answer with a Markdown table: one row per item, one column per attribute asked for, a citation marker right after every document value. Search and read until every occurrence is covered, and say which pages you went through. A value you could not find is "—" with no marker, never a guess. Keep \`|\` out of quotes in table cells.
- If no document is loaded, ask the user to open a PDF.
- Re-reading a page still above returns a short marker; one summarized to a line returns its text — re-read it before quoting.
- Tool results carry attachments beside the page text, one field each. \`marks\` are passages the reader singled out, with notes — their strongest signal of what matters, and read-only. \`links\` are hyperlink destinations, which live only in the PDF's annotations, never in the page text; the line each sits on is its context. The outline's \`pagesWithFigures\` names pages where read_figure can look at a figure the text does not convey.
- A page that failed to index (missing key, vision error, timeout) is not blank: do not treat it as empty, do not re-read it, and tell the user indexing failed.`;

const OPENAI_CACHE_BREAKPOINT_MODEL = /^gpt-(?:5\.[6-9]|[6-9])(?:$|[-.])/;

export function systemMessageFor(
  settings: Pick<LlmSettings, "provider"> & { model?: string },
): Instructions {
  const model = (settings.model ?? "").trim().toLowerCase();
  if (settings.provider === "openai" && OPENAI_CACHE_BREAKPOINT_MODEL.test(model)) {
    return {
      role: "system",
      content: SYSTEM_INSTRUCTIONS,
      providerOptions: { openai: { promptCacheBreakpoint: { mode: "explicit" } } },
    };
  }
  if (settings.provider === "openrouter" && model.startsWith("anthropic/")) {
    return {
      role: "system",
      content: SYSTEM_INSTRUCTIONS,
      providerOptions: {
        openrouter: { cacheControl: { type: "ephemeral" } },
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    };
  }
  return SYSTEM_INSTRUCTIONS;
}

/**
 * Repair a tool call whose arguments failed schema validation. Handles the most
 * common weak-model mistake — numeric fields sent as strings (e.g. {"page":"5"})
 * — deterministically, without a second model round-trip. Returns null to fall
 * through (no repair) for anything else, including unknown-tool errors.
 */
const repairDocumentToolCall: ToolCallRepairFunction<any> = async ({ toolCall, error }) => {
  if (!InvalidToolInputError.isInstance(error)) return null;
  const repaired = coerceNumericToolInput(toolCall.input);
  if (repaired === null) return null;
  return { ...toolCall, input: repaired };
};

/**
 * Progressive tool disclosure: with no document loaded, expose no tools so the
 * model asks the user to open a PDF instead of calling tools that would throw.
 * Returns undefined (all tools active) once a document is present.
 */
function resolveActiveTools(hasActiveDoc: boolean): DocumentToolName[] | undefined {
  return hasActiveDoc ? undefined : [];
}

function buildToolsContext(runtime: ReturnType<typeof buildRuntimeContext>) {
  const docCtx = buildDocToolContext(runtime);
  return {
    document_outline: docCtx,
    read_pdf_page: docCtx,
    read_pdf_range: docCtx,
    search_in_document: docCtx,
    read_figure: docCtx,
    read_section: docCtx,
    note_finding: docCtx,
    revise_finding: docCtx,
  };
}

export function createDocAgent() {
  const budget = newReadBudget();
  let runMaxSteps = DEFAULT_MAX_AGENT_STEPS;
  let runKeepChars = KEEP_RECENT_CHARS;
  let runReasoning: ReturnType<typeof resolveReasoning> = undefined;
  const tools = createDocumentTools(budget);
  const defaultRuntime = buildRuntimeContext(null);

  return new ToolLoopAgent({
    model: resolveModel(DEFAULT_SETTINGS),
    instructions: SYSTEM_INSTRUCTIONS,
    tools,
    toolsContext: buildToolsContext(defaultRuntime),
    stopWhen: stopWhenFor(DEFAULT_MAX_AGENT_STEPS),
    // A provider that accepts the connection and then goes quiet used to leave
    // the run streaming with no end and no error. See agent-timeouts.ts for why
    // each number is as generous as it is.
    timeout: AGENT_TIMEOUT,
    // A provider error that arrives after the step's stream has started — an
    // OpenRouter upstream hiccup, a DeepSeek overload at step 12 — used to end
    // the whole run, and the retry the reader then pressed paid for every page
    // again. AI SDK 7.0.91 can rerun just the failed step, keeping the steps
    // and tool results before it. One retry: a second failure is not a hiccup.
    // Text the failed attempt already streamed cannot be taken back, so a
    // retried answering step may repeat its opening; a repeated sentence is a
    // smaller cost than a discarded run. `ToolLoopAgent` forwards the setting
    // to `streamText` but its settings type does not declare it yet.
    ...({ streamRetries: STREAM_RETRIES } as object),
    // The order tools are offered in nudges which one gets picked, without
    // spending prompt on saying so: locate, then read, then the survey.
    toolOrder: [
      SEARCH_IN_DOCUMENT_TOOL,
      READ_PDF_PAGE_TOOL,
      READ_PDF_RANGE_TOOL,
      READ_SECTION_TOOL,
      DOCUMENT_OUTLINE_TOOL,
      READ_FIGURE_TOOL,
      // The writers last: reading comes before recording, and the order is a
      // free nudge that costs no prompt to say.
      NOTE_FINDING_TOOL,
      REVISE_FINDING_TOOL,
    ],
    repairToolCall: repairDocumentToolCall,
    experimental_refineToolInput: {
      [READ_PDF_RANGE_TOOL]: (input) => normalizeRangeInput(input),
    },
    // Force a text answer instead of another tool call when the run is about to
    // end with no synthesis:
    //   1. the last allowed step (step ceiling), and
    //   2. an imminent meta-tool loop — the prior steps already repeat a meta
    //      call (window 2), so without this the next repeat would trip
    //      stopMetaToolLoop and the run would end on a tool call → "noReply".
    // Only sets toolChoice; never mutates messages, so tool-call/result pairing
    // is safe.
    prepareStep: ({ stepNumber, steps, messages }) => {
      const compacted = compactRunMessages(
        messages as ReadonlyArray<{ role: string; content: unknown }> | undefined,
        runKeepChars,
        (pages) => {
          for (const page of pages) forgetDelivered(budget, page);
        },
      ) as typeof messages;

      const withSteer = withSteerMessage(compacted ?? [], budget.gen) as typeof messages;
      const carry = withSteer !== messages ? { messages: withSteer } : {};

      if (stepNumber >= runMaxSteps - 1) {
        return { ...carry, toolChoice: "none", reasoning: runReasoning };
      }
      if (steps.length >= 2 && isMetaToolOnlyLoop(toMetaLoopSnapshot(steps), 2)) {
        return { ...carry, toolChoice: "none", reasoning: runReasoning };
      }
      return { ...carry, reasoning: stepReasoning(runReasoning, steps as ReadonlyArray<StepLike>) };
    },
    prepareCall: async ({ toolsContext, runtimeContext: incomingRuntime, ...rest }) => {
      budget.used = 0;
      budget.scans = 0;
      budget.gen += 1;
      budget.delivered.clear();
      budget.pageReads.clear();
      beginSteerRun(budget.gen);

      const settings = await loadSettings();
      const runtime =
        (incomingRuntime as PageWiseRuntimeContext | undefined) ??
        buildRuntimeContext(null);
      const viewCtx = runtime.messageContext;
      let viewHint = viewCtx ? buildViewContextInstructions(viewCtx) : "";

      if (viewCtx && hasWholeDocumentIntent(viewCtx.userText)) {
        viewHint += buildWholeDocumentInstructions(viewCtx);
      }
      viewHint += buildDocumentMapInstructions(runtime.activeDocPath, viewCtx?.viewingPage ?? 0);
      viewHint += buildRecordInstructions(runtime.activeDocPath);
      viewHint += buildCitationFeedback(
        runtime.activeDocPath,
        rest.prompt as ReadonlyArray<{ role: string; content: unknown }> | undefined,
      );
      viewHint += labelHintFor(runtime.activeDocPath);
      runMaxSteps = resolveRunMaxSteps(viewCtx?.totalPages ?? 0);
      runKeepChars = runKeepRecentChars(settings.provider, settings.model);
      budget.max = runTokenBudget(settings.provider, settings.model);
      budget.maxScans = getAgentScanCap();
      runReasoning = resolveReasoning(settings);

      return {
        ...rest,
        // The volatile half of the prompt rides on the newest user message, so
        // the system prompt — the first block every provider caches on — is
        // byte-identical from turn to turn. See appendContextToLastUserMessage.
        // `prompt`, not `messages`. prepareCall receives the model messages under
        // `prompt`; `rest.messages` is undefined, so appending to it built the
        // hint and threw it away. That was silent for as long as this code has
        // existed — the view context ("Active document…", "the user is viewing
        // page N") and the whole-document instructions were all being discarded
        // with it, and nothing failed. Found by dumping the request body the
        // provider actually receives, which is the only place it shows.
        prompt: appendContextToLastUserMessage(
          rest.prompt as ReadonlyArray<{ role: string; content: unknown }> | undefined,
          viewHint,
        ) as typeof rest.prompt,
        stopWhen: stopWhenFor(runMaxSteps),
        model: resolveModel(settings),
        reasoning: runReasoning,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        instructions: systemMessageFor(settings),
        runtimeContext: runtime,
        activeTools: resolveActiveTools(!!runtime.activeDocPath),
        toolsContext: {
          ...toolsContext,
          ...buildToolsContext(runtime),
        },
      };
    },
  });
}
