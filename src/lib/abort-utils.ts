/** Throw when the signal is already aborted (matches DOM AbortError). */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Operation aborted", "AbortError");
  }
}

/** Reject when `signal` aborts; resolves with the promise result otherwise. */
export function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  if (signal.aborted) {
    return Promise.reject(new DOMException("Operation aborted", "AbortError"));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(new DOMException("Operation aborted", "AbortError"));
          return;
        }
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Merge optional abort sources into one signal, if any. */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const parts = signals.filter(Boolean) as AbortSignal[];
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return AbortSignal.any(parts);
}
