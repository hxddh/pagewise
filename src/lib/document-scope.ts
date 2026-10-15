/**
 * One document's module state, in one place.
 *
 * Thirteen modules keep per-document state at module level — rendered pages,
 * loaded text, marks, findings, finding anchors, citation checks, claim
 * reviews, OCR results, the indexing queue, page-index events, vision spend,
 * the index store's fingerprint for the open file, the pending agent message
 * context — and the only thing that cleaned them up was a
 * hand-written list in the session provider. The bug class this file exists
 * for is recorded three times in the repository's history: something a reader
 * saw in document A showing up under document B.
 *
 * A list you have to remember is not a mechanism. This is: `create` opens a
 * scope for the document being opened, `dispose` closes every registered
 * cache for the one being left, and a new scope disposes the previous one on
 * its own. `pdf.ts`'s cache internals are registered here, not rewritten.
 */
import { clearSteerNotes } from "./agent-steer";
import { clearAgentMessageContext } from "./agent-view-context";
import { clearCitationChecks } from "./citation-check";
import { clearReviews } from "./claim-review";
import { docCache } from "./doc-cache";
import { clearFindingAnchors } from "./finding-anchors";
import { flushFindingStore, forgetFindings } from "./finding-store";
import { clearDocumentIndexState } from "./index-events";
import { flushMarkStore, forgetMarks } from "./mark-store";
import { forgetIndexIdentity } from "./index-store";
import { clearPdfCache, setActivePdfPath } from "./pdf";
import { forgetOcr } from "./ocr/ocr-service";
import { forgetDocumentUsage } from "./usage-tracker";
import { cancelIndex } from "../document/index-queue";

/** How one module's per-document state starts and stops. */
export interface DocumentState {
  /** Short name, for the regression test. */
  name: string;
  create?: (path: string) => void;
  dispose: (path: string) => void;
}

/**
 * Every per-document cache and module state, in teardown order: a cache that
 * flushes on its way out (marks, findings) is told to flush before the store
 * forgets it, and the ones derived from the file go with it.
 */
const REGISTRATIONS: DocumentState[] = [
  { name: "index-queue", dispose: (path) => cancelIndex(path) },
  { name: "ocr-service", dispose: (path) => forgetOcr(path) },
  { name: "doc-cache", dispose: (path) => docCache.remove(path) },
  {
    name: "mark-store",
    dispose: (path) => {
      // Marks are the reader's own work: flush the durable copy before the
      // in-memory one goes.
      void flushMarkStore().then(() => forgetMarks(path));
    },
  },
  {
    name: "finding-store",
    dispose: (path) => {
      void flushFindingStore().then(() => forgetFindings(path));
    },
  },
  { name: "finding-anchors", dispose: (path) => clearFindingAnchors(path) },
  { name: "citation-check", dispose: (path) => clearCitationChecks(path) },
  { name: "claim-review", dispose: (path) => clearReviews(path) },
  { name: "index-events", dispose: (path) => clearDocumentIndexState(path) },
  // Vision spend and the fingerprint the index store writes beside a
  // document's pages: both keyed by path, both part of one document's state,
  // and both outside this list until 20.0 — so the scan-all confirmation
  // showed a reopened document the previous session's call count, and the two
  // maps kept an entry per document opened all session.
  { name: "usage-tracker", dispose: (path) => forgetDocumentUsage(path) },
  { name: "index-store-identity", dispose: (path) => forgetIndexIdentity(path) },
  { name: "agent-view-context", dispose: () => clearAgentMessageContext() },
  // Corrections typed for a run on the document being left: never delivered
  // to the next document's run (21.0 — nothing in the app called this).
  { name: "agent-steer", dispose: () => clearSteerNotes() },
  {
    name: "pdf-render",
    create: (path) => setActivePdfPath(path),
    dispose: () => clearPdfCache(),
  },
];

export interface DocumentScope {
  path: string;
  /** Close this document's state. Safe to call more than once. */
  dispose(): void;
}

let activeScope: DocumentScope | null = null;

/**
 * Open the scope for `path`, disposing the previous document's scope first.
 * The automatic dispose is the point: a caller that forgets leaks the previous
 * document into the next one.
 */
export function createDocumentScope(path: string): DocumentScope {
  if (activeScope && activeScope.path !== path) activeScope.dispose();
  const scope: DocumentScope = {
    path,
    dispose() {
      for (const entry of REGISTRATIONS) entry.dispose(path);
      if (activeScope === scope) activeScope = null;
    },
  };
  for (const entry of REGISTRATIONS) entry.create?.(path);
  activeScope = scope;
  return scope;
}

/** For tests only: forget the active scope without touching the caches. */
export function __resetDocumentScopeForTests(): void {
  activeScope = null;
}
