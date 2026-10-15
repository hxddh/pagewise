/**
 * Told when a document's recognised words are replaced (22.0).
 *
 * A change of OCR language drops a document's pages and reads its other
 * section back in. Everything worked out from the old words — a page's runs,
 * a citation's check, the passage a model's verdict is keyed by — would
 * otherwise go on describing words the page no longer has (Codex on #157).
 * A module of its own, so the caches that listen need not import the service.
 */
type Listener = (path: string) => void;

const listeners = new Set<Listener>();

export function onOcrTextReplaced(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function ocrTextReplaced(path: string): void {
  for (const l of [...listeners]) l(path);
}
