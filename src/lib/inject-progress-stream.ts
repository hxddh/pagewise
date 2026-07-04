import type { UIMessageChunk } from "ai";
import {
  clearAgentProgress,
  subscribeAgentProgress,
  type AgentProgressPayload,
} from "./agent-progress";

const PROGRESS_DATA_TYPE = "data-agent-progress" as const;

export type AgentProgressDataPart = {
  type: typeof PROGRESS_DATA_TYPE;
  data: AgentProgressPayload;
  transient?: boolean;
};

/** Inject transient progress data parts into a UI message chunk stream. */
export function wrapStreamWithAgentProgress(
  stream: ReadableStream<UIMessageChunk>,
): ReadableStream<UIMessageChunk> {
  let streamController: ReadableStreamDefaultController<UIMessageChunk> | null = null;
  let closed = false;

  const enqueueProgress = (payload: AgentProgressPayload) => {
    if (closed || !streamController) return;
    try {
      streamController.enqueue({
        type: PROGRESS_DATA_TYPE,
        data: payload,
        transient: true,
      } as UIMessageChunk);
    } catch {
      /* stream may have closed */
    }
  };

  const unsubscribe = subscribeAgentProgress(enqueueProgress);

  const source = stream.getReader();

  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      streamController = controller;
    },
    async pull(controller) {
      streamController = controller;
      const { done, value } = await source.read();
      if (done) {
        closed = true;
        unsubscribe();
        clearAgentProgress();
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      closed = true;
      unsubscribe();
      clearAgentProgress();
      void source.cancel();
    },
  });
}

export function isAgentProgressDataPart(
  part: { type: string; data?: unknown },
): part is AgentProgressDataPart {
  return part.type === PROGRESS_DATA_TYPE;
}
