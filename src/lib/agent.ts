import {
  ToolLoopAgent,
  stepCountIs,
  InvalidToolInputError,
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
  buildViewContextInstructions,
  buildWholeDocumentInstructions,
} from "./agent-view-context";
import { AGENT_TIMEOUT } from "./agent-timeouts";
import { buildRecordInstructions } from "./agent-record-context";
import { compactRunMessages } from "./compact-run-messages";
import { beginSteerRun, withSteerMessage } from "./agent-steer";
import { resolveModel, resolveReasoning } from "./llm";
import { hasWholeDocumentIntent } from "./page-intent";
import { loadSettings } from "./settings";
import { getAgentScanCap } from "../document/index-queue";
import { DEFAULT_SETTINGS } from "./types";
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
  RUN_CHAR_BUDGET,
} from "./agent-tools";

// The tool layer moved to ./agent-tools; these keep their long-standing import
// path for the rest of the app and the tests.
export {
  createDocumentTools,
  newReadBudget,
  compressPageRanges,
  DEFAULT_PAGE_MAX_CHARS,
  DEFAULT_RANGE_MAX_CHARS,
  DEFAULT_SEARCH_HITS,
  DEFAULT_FIGURE_INDEX,
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

const AGENT_STOP_WHEN = [stepCountIs(DEFAULT_MAX_AGENT_STEPS), stopMetaToolLoop];

/**
 * Ceiling on one reply. Generous — a synthesis over twenty pages is long — but
 * a generation that runs away is otherwise unbounded in both cost and wait.
 */
const MAX_OUTPUT_TOKENS = 8_000;

/**
 * Reasoning effort for the steps that only fetch. Deliberation is billed output
 * and "read page 14 next" does not need any; the step that has to turn twelve
 * pages into an answer does, and gets the configured level back.
 */
const MECHANICAL_STEP_REASONING = "low" as const;

/**
 * The reasoning effort for a step that still has tools available.
 *
 * `prepareStep` runs BEFORE the step, so it cannot know whether the model is
 * about to call a tool or write the answer. The previous rule restored full
 * effort only at `stepNumber >= runMaxSteps - 1` — the step ceiling — and its
 * comment claimed that was "the step that writes the answer". It is not: a run
 * ends when the model decides it has enough, which in practice is step 3 or 4
 * of a permitted 20. Measured against a real request: a four-step run sent
 * `reasoning_effort: "low"` on all four, the answering one included, while the
 * run was configured for `medium`. Full effort was being spent only when the
 * run was being cut off, which is the least useful moment there is.
 *
 * Since which step answers is unknowable in advance, this bets the other way:
 * only the steps with nothing to reason over yet are mechanical. "Go find
 * something" is; every step after the first tool result might be the answer.
 *
 * THE COST IS REAL. A twenty-step run now spends nineteen steps at full effort
 * instead of one, so most of the saving this was written for is given back. The
 * trade was made deliberately — an answer written at low effort is the thing
 * the reader actually receives, and it cannot be measured from here without a
 * live model, so the choice went to quality over a number nobody can check.
 */
export function stepReasoning<R>(
  runReasoning: R | undefined,
  hasMaterial: boolean,
): R | typeof MECHANICAL_STEP_REASONING | undefined {
  if (!runReasoning) return undefined;
  return hasMaterial ? runReasoning : MECHANICAL_STEP_REASONING;
}




const SYSTEM_INSTRUCTIONS = `You are PageWise, a local desktop PDF assistant.

Rules:
- Use tools to read document content; never invent page text. Ground your answers in what you read and cite pages for document facts — then explain, interpret, reason, and synthesize freely, adding background knowledge when it helps, while keeping clear what comes from the document vs. your own knowledge.
- The user has one active PDF; omit path on tools to use it.
- Sparse or scan pages are indexed via vision — wait for read results.
- Pick tools freely to answer: search_in_document locates where a term appears, read_pdf_page / read_pdf_range read specific pages, document_outline surveys structure. Search is often the fastest start for a keyword and an outline for a broad task, but read directly when that's more direct.
- If search returns nothing useful, read the relevant page(s) anyway — a figure or scanned page defeats search, so "no hits" does not mean the content is absent; read the page(s) before concluding something isn't in the document.
- When the user asks about a term or topic while viewing a page, read that page first — it is usually what they mean; read where an ambiguous term (e.g. an acronym) appears rather than guessing its meaning.
- If a page doesn't fully answer, read adjacent pages or search again before replying; don't answer a document-spanning question from a single page.
- When you state a fact from the document, cite its page (e.g. "page 5"); quote short key passages verbatim rather than paraphrasing.
- If no document is loaded, ask the user to open a PDF.
- Pages reported as unindexed have little or no extracted text, so search cannot match them. "No hits" is not evidence the content is absent; reading such a page scans it on demand, which costs a billed vision call from a limited per-question allowance — read only the pages you need, and say so plainly if the allowance runs out.
- A page already returned in full during this turn comes back as a short marker instead of its text. The text is above; do not re-read it to see it again.
- Tool results carry attachments beside the page text, each with its own field. \`marks\` are passages the reader singled out, with their notes — the strongest signal of what they care about, and read-only: you cannot create or change them. \`links\` are hyperlink destinations, which live in the PDF's annotations and never in the page text; the line each sits on is its context. \`figures\` / \`pagesWithFigures\` name pages where read_figure can look at a chart, diagram or photograph the text does not convey.
- A page reported as failing to index (missing key, vision error, timeout) is not a blank page. Do not treat it as empty, do not re-read it hoping for a different result, and tell the user indexing failed.`;

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
  // The reasoning effort this run was configured with. Steps that have nothing
  // to reason over yet drop below it (see `stepReasoning`); every step after
  // the first tool result keeps it, because any of them might be the answer.
  let runReasoning: ReturnType<typeof resolveReasoning> = undefined;
  const tools = createDocumentTools(budget);
  const defaultRuntime = buildRuntimeContext(null);

  return new ToolLoopAgent({
    model: resolveModel(DEFAULT_SETTINGS),
    instructions: SYSTEM_INSTRUCTIONS,
    tools,
    toolsContext: buildToolsContext(defaultRuntime),
    stopWhen: AGENT_STOP_WHEN,
    // A provider that accepts the connection and then goes quiet used to leave
    // the run streaming with no end and no error. See agent-timeouts.ts for why
    // each number is as generous as it is.
    timeout: AGENT_TIMEOUT,
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
      // Shorten the reads the model has already moved past. A tool loop resends
      // every earlier result on every step, so without this a twenty-step run
      // pays for the same pages up to twenty times. The most recent results are
      // left whole — those are what this step is reasoning over.
      const compacted = compactRunMessages(
        messages as ReadonlyArray<{ role: string; content: unknown }> | undefined,
      ) as typeof messages;

      // A correction the reader typed while this run was working. Appended at
      // the very end, after the last tool result, so every tool call still sits
      // next to its own result — the pairing the provider validates. Sending
      // during a run used to stop it and start another, which put every page it
      // had read back into a fresh context at full price.
      const withSteer = withSteerMessage(compacted ?? [], budget.gen) as typeof messages;
      const carry = withSteer !== messages ? { messages: withSteer } : {};

      // Reasoning is billed output, and most steps of a document run are
      // mechanical — "read page 14" needs no deliberation. The step that has to
      // put the answer together does, and that is the one with no tools left.
      if (stepNumber >= runMaxSteps - 1) {
        return { ...carry, toolChoice: "none", reasoning: runReasoning };
      }
      // 7.1 retired document_outline here, by dropping it from activeTools once
      // it had been used. That changes the tool block — which sits ahead of the
      // messages in the request — so the cached prefix (~1,400 tokens of system
      // prompt and tool schemas) missed for the whole rest of the run. It saved
      // one schema per step, about 150 tokens, and paid far more than that back
      // on any run with more than a step or two left; the runs that consult the
      // outline are the long ones. The tool set is now fixed for the run, and
      // the "don't re-read the tree" nudge rides in the outline's own result,
      // where it costs nothing to say and cannot invalidate the prefix. The
      // meta-loop guard below still stops an actual repeat.
      if (steps.length >= 2 && isMetaToolOnlyLoop(toMetaLoopSnapshot(steps), 2)) {
        return { ...carry, toolChoice: "none", reasoning: runReasoning };
      }
      // Anything already read is material this step could answer from.
      const hasMaterial = steps.some((step) => step.toolCalls.length > 0);
      return { ...carry, reasoning: stepReasoning(runReasoning, hasMaterial) };
    },
    prepareCall: async ({ toolsContext, runtimeContext: incomingRuntime, ...rest }) => {
      budget.used = 0;
      budget.scans = 0;
      budget.gen += 1;
      budget.delivered.clear();
      // A correction typed as the previous run was ending belongs to that run.
      // Carrying it into this one would put words in the reader's mouth: they
      // were correcting an answer they have since received, and this question
      // came with its own.
      beginSteerRun(budget.gen);

      const settings = await loadSettings();
      const runtime =
        (incomingRuntime as PageWiseRuntimeContext | undefined) ??
        buildRuntimeContext(null);
      const viewCtx = runtime.messageContext;
      let viewHint = viewCtx ? buildViewContextInstructions(viewCtx) : "";

      // The whole-document intent regex now ONLY adds an optional survey hint —
      // it no longer gates how much of the document the agent is allowed to read.
      // Budget and step room are uniform, so a broad question phrased outside the
      // keyword set is never silently capped.
      if (viewCtx && hasWholeDocumentIntent(viewCtx.userText)) {
        viewHint += buildWholeDocumentInstructions(viewCtx);
      }
      // What earlier questions already established, so this one does not have to
      // re-derive it. Appended to the user message with the rest of the volatile
      // context — never to the system prompt, which is what providers cache.
      viewHint += buildRecordInstructions(runtime.activeDocPath);
      runMaxSteps = resolveRunMaxSteps(viewCtx?.totalPages ?? 0);
      budget.max = RUN_CHAR_BUDGET;
      // Read at call time so a Settings change takes effect on the next
      // question without restarting the app.
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
        stopWhen: [stepCountIs(runMaxSteps), stopMetaToolLoop],
        model: resolveModel(settings),
        reasoning: runReasoning,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        instructions: SYSTEM_INSTRUCTIONS,
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
