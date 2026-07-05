import type { Context } from "@ai-sdk/provider-utils";
import type { AgentMessageContext } from "./agent-view-context";
import { docCache } from "./doc-cache";

/** Shared runtime state for a single agent run (prepareCall → tools). */
export interface PageWiseRuntimeContext extends Context {
  activeDocPath: string | null;
  activeDocName: string | null;
  viewingPage: number | null;
}

/** Per-tool default path injected via toolsContext. */
export interface PageWiseDocToolContext extends Context {
  defaultDocPath: string | null;
}

export function buildRuntimeContext(
  viewCtx: AgentMessageContext | null,
): PageWiseRuntimeContext {
  const loaded = docCache.list();
  const soleDoc = loaded.length === 1 ? loaded[0] : undefined;
  return {
    activeDocPath: viewCtx?.path ?? soleDoc?.path ?? null,
    activeDocName: viewCtx?.docName ?? soleDoc?.name ?? null,
    viewingPage: viewCtx?.viewingPage ?? null,
  };
}

export function buildDocToolContext(
  runtime: PageWiseRuntimeContext,
): PageWiseDocToolContext {
  return { defaultDocPath: runtime.activeDocPath };
}

/** Resolve document path from tool input or runtime default. */
export function resolveDocPath(
  inputPath: string | undefined,
  defaultPath: string | null,
): string {
  const trimmed = inputPath?.trim();
  if (trimmed) return trimmed;
  if (defaultPath) return defaultPath;
  throw new Error(
    "document path is required — no active document in context; call list_documents first.",
  );
}
