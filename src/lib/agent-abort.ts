let agentRunAbortSignal: AbortSignal | undefined;

export function setAgentRunAbortSignal(signal: AbortSignal | undefined): void {
  agentRunAbortSignal = signal;
}

export function clearAgentRunAbortSignal(): void {
  agentRunAbortSignal = undefined;
}

export function getAgentRunAbortSignal(): AbortSignal | undefined {
  return agentRunAbortSignal;
}

/**
 * Whether the last run was ended by a deadline rather than by the reader.
 *
 * `agent-timeouts.ts` bounds a run whose provider has gone quiet, and was
 * written so the reader would learn that the connection had died. It did not
 * say so: a timeout aborts the run, and an aborted run looks exactly like the
 * reader pressing Stop — no message, no error. AI SDK 7.0 hands `onAbort` the
 * signal's reason, and a deadline's reason is a `TimeoutError`.
 */
let runTimedOut = false;

export function isTimeoutReason(reason: unknown): boolean {
  return !!reason && typeof reason === "object" && (reason as { name?: unknown }).name === "TimeoutError";
}

export function noteRunTimedOut(): void {
  runTimedOut = true;
}

/** Read and clear: each timeout is reported once. */
export function consumeRunTimedOut(): boolean {
  const was = runTimedOut;
  runTimedOut = false;
  return was;
}
