/**
 * How long the app waits on a model that has stopped answering.
 *
 * Nothing here bounded a request before. The two background vision paths were
 * written with deadlines — `index-queue` and `read-figure` both wrap their
 * signal in `AbortSignal.timeout(60_000)` — but the agent run and the two probe
 * buttons in Settings had none at all. So the paths someone thought about were
 * bounded and the paths nobody thought about were not, which is the usual shape
 * of this bug.
 *
 * What that costs: a provider that accepts the connection and then stops
 * sending leaves the run streaming forever. The reader sees a spinner with no
 * end and no error, and the only way out is the stop button — which they have
 * no reason to press, because from the outside a hung connection and a model
 * thinking hard look identical.
 *
 * The numbers below are deliberately generous. A timeout that fires early is
 * worse than one that fires late: it kills a run that was working, and the
 * reader pays the whole context again on the retry. These are set to catch a
 * connection that is dead, not one that is slow.
 */

import type { TimeoutConfiguration } from "ai";

/**
 * Time allowed before the first chunk arrives.
 *
 * This is the slowest legitimate wait in the app: a reasoning model with a full
 * cached prefix, a system prompt and six tool schemas ahead of it can take the
 * better part of a minute to produce its first token, and a cold cache is
 * slower still. Ninety seconds is roughly twice the worst honest case.
 */
const FIRST_CHUNK_MS = 90_000;

/**
 * Time allowed between chunks once the answer has started.
 *
 * Much tighter, because the meaning is different. Before the first chunk the
 * model may be thinking; after it, a gap this long is a dropped connection.
 * Reasoning models do pause mid-answer between blocks, hence 45s rather than
 * something aggressive.
 */
const CHUNK_MS = 45_000;

/**
 * Ceiling on one whole agent run, every step included.
 *
 * This is a backstop, not the mechanism. The run is already bounded from two
 * directions: `stopWhen: stepCountIs(runMaxSteps)` caps it at 30 steps, and the
 * chunk deadlines above cap how long any one of those steps can hang. What is
 * left for a total to catch is a loop that keeps making slow progress forever,
 * which the step count should already have caught.
 *
 * So it is set above the true worst case rather than at a round number: 30
 * steps that each spend the full tool ceiling in vision is 37.5 minutes, and a
 * total below that could abort a long survey that was working. The first draft
 * of this file said twenty minutes, which was under it — a test comparing the
 * two is what caught that, not the arithmetic.
 */
const TOTAL_MS = 45 * 60_000;

/**
 * Ceiling on a single tool call.
 *
 * Most of these are local — a page comes out of the document cache in
 * milliseconds. The exception is a read that has to index the page first, which
 * goes to the vision model; that path already carries its own 60s deadline, so
 * this sits just above it and catches the case where the tool hangs somewhere
 * that deadline does not cover.
 */
const TOOL_MS = 75_000;

/**
 * The agent run's deadlines. Passed to ToolLoopAgent as `timeout`.
 *
 * `satisfies` rather than a type annotation: `TimeoutConfiguration` is a union
 * with a bare `number`, so annotating widens this to that union and the fields
 * stop being readable — which the tests below need in order to check the
 * relationships between them.
 */
export const AGENT_TIMEOUT = {
  firstChunkMs: FIRST_CHUNK_MS,
  chunkMs: CHUNK_MS,
  totalMs: TOTAL_MS,
  toolMs: TOOL_MS,
} satisfies TimeoutConfiguration<never>;

/**
 * Deadline for the two "Test connection" buttons in Settings.
 *
 * Far shorter than a run, because the question being asked is different. A run
 * may legitimately run for the better part of an hour; a health check that has
 * not answered in
 * thirty seconds has answered — the endpoint is wrong, or unreachable, or
 * sitting behind something that will never reply. Leaving the button spinning
 * past that point tells the reader nothing they cannot already see.
 */
export const CONNECTION_TEST_TIMEOUT_MS = 30_000;
