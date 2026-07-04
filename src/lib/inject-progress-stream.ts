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
  initialProgress: AgentProgressPayload[] = [],
): ReadableStream<UIMessageChunk> {
  let streamController: ReadableStreamDefaultController<UIMessageChunk> | null =
    null;
  let closed = false;
  const pendingProgress: AgentProgressPayload[] = [...initialProgress];

  const enqueueProgress = (payload: AgentProgressPayload) => {
    if (closed) return;
    if (!streamController) {
      pendingProgress.push(payload);
      return;
    }
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
    start(controller) {
      streamController = controller;
      for (const payload of pendingProgress) enqueueProgress(payload);
      pendingProgress.length = 0;
      void pump();
    },
    cancel() {
      closed = true;
      unsubscribe();
      clearAgentProgress();
      void source.cancel();
    },
  });

  async function pump() {
    const controller = streamController;
    if (!controller) return;

    try {
      for (;;) {
        const { done, value } = await source.read();
        if (done) break;
        controller.enqueue(value);
      }
      closed = true;
      unsubscribe();
      clearAgentProgress();
      controller.close();
    } catch (error) {
      closed = true;
      unsubscribe();
      clearAgentProgress();
      controller.error(error);
    }
  }
}

export function isAgentProgressDataPart(
  part: { type: string; data?: unknown },
): part is AgentProgressDataPart {
  return part.type === PROGRESS_DATA_TYPE;
}
