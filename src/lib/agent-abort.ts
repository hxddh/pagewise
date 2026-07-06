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
