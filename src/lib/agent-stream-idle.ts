const STREAM_SETTLE_MS = 10_000;
const STREAM_POLL_MS = 50;

export interface StreamIdleHandles {
  isBusy: () => boolean;
  stop: () => void;
  abortPendingSend: () => void;
  forceReset: () => void;
}

/** Wait for agent streaming / pending send to settle before persisting or switching docs. */
export async function waitForStreamIdle(handles: StreamIdleHandles): Promise<boolean> {
  const busy = () => handles.isBusy();
  if (!busy()) return true;

  handles.stop();
  handles.abortPendingSend();

  const deadline = Date.now() + STREAM_SETTLE_MS;
  while (busy() && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, STREAM_POLL_MS));
  }

  if (busy()) {
    handles.forceReset();
    await new Promise((resolve) => window.setTimeout(resolve, STREAM_POLL_MS));
  }

  return !busy();
}
