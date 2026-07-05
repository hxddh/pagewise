import { docCache } from "./doc-cache";
import { throwIfAborted } from "./abort-utils";
import { getAgentRunAbortSignal } from "./vision-index";
import {
  cosineSimilarity,
  embedText,
  embedTexts,
  embeddingModelKey,
} from "./embeddings";
import { isEmbeddingCapableProvider } from "./model-capabilities";
import { MIN_INDEX_CHARS } from "./page-text-merge";
import { loadSettings } from "./settings";
import type { PageText } from "./types";
import { searchDocumentPages, type SearchHit } from "./document-search";
import { fuseSearchHits, rerankSearchHits, type RankableHit } from "./search-rerank";

interface PageEmbedding {
  page: number;
  vector: number[];
}

interface SemanticIndexEntry {
  /** Embedding-model key that produced these vectors (provider drift guard). */
  model: string;
  /** Vector dimensionality (dimension-mismatch guard). */
  dim: number;
  entries: PageEmbedding[];
}

export interface SemanticEmbedCapInfo {
  embedded: number;
  eligible: number;
}

const store = new Map<string, SemanticIndexEntry>();
const buildPromises = new Map<string, Promise<void>>();
/** Paths whose cached index is stale (e.g. background OCR landed new page text). */
const dirty = new Set<string>();
/** Bumped when dirty is marked during an in-flight build — prevents clearing stale too early. */
const dirtyGeneration = new Map<string, number>();
/** Consecutive failed embed builds per path — bail out to keyword-only after cap. */
const failedBuildAttempts = new Map<string, number>();
const MAX_EMBED_BUILD_ATTEMPTS = 2;
/** Providers we've already warned about lacking an embeddings endpoint (DEV only). */
const warnedNoEmbed = new Set<string>();

let embedCapHandler: ((path: string, info: SemanticEmbedCapInfo) => void) | null = null;
/** Per-document abort handles — cancelling doc A must not kill doc B's in-flight embed. */
const buildAbortByPath = new Map<string, AbortController>();
/** Rotate embed window across capped rebuilds so tail pages eventually get vectors. */
const embedWindowOffset = new Map<string, number>();

/** Abort in-flight semantic builds (document switch). */
export function abortSemanticIndexBuild(path?: string): void {
  if (path) {
    buildAbortByPath.get(path)?.abort();
    buildAbortByPath.delete(path);
    return;
  }
  for (const controller of buildAbortByPath.values()) controller.abort();
  buildAbortByPath.clear();
}

/** Register a toast handler when semantic embedding hits the page cap. */
export function setSemanticEmbedCapHandler(
  handler: ((path: string, info: SemanticEmbedCapInfo) => void) | null,
): void {
  embedCapHandler = handler;
}

/** Relative cutoff: keep semantic hits within this cosine gap of the best hit… */
const RELATIVE_GAP = 0.15;
/** …but never below this absolute floor, to avoid surfacing pure noise. */
const SCORE_FLOOR = 0.15;

function pageEmbedText(text: string, page: number): string {
  const trimmed = text.trim();
  if (!trimmed) return `Page ${page}`;
  return trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}…` : trimmed;
}

function resolvePages(path: string, fallback: PageText[]): PageText[] {
  const live = docCache.getPages(path);
  return live.length > 0 ? live : fallback;
}

/** Upsert fresh vectors into prior entries by page number (capped builds accumulate). */
function mergePageEmbeddings(
  prior: PageEmbedding[] | undefined,
  fresh: PageEmbedding[],
): PageEmbedding[] {
  const byPage = new Map<number, PageEmbedding>();
  for (const entry of prior ?? []) byPage.set(entry.page, entry);
  for (const entry of fresh) byPage.set(entry.page, entry);
  return [...byPage.values()].sort((a, b) => a.page - b.page);
}

export function clearSemanticIndex(path: string): void {
  abortSemanticIndexBuild(path);
  store.delete(path);
  buildPromises.delete(path);
  dirty.delete(path);
  dirtyGeneration.delete(path);
  failedBuildAttempts.delete(path);
  embedWindowOffset.delete(path);
}

/**
 * Mark a document's index stale so the next {@link ensureSemanticIndex} rebuilds it.
 * Called when page text changes underneath us (background OCR/vision indexing) so
 * newly-recognized pages get embedded instead of being missed forever.
 */
export function markSemanticIndexDirty(path: string): void {
  dirty.add(path);
  dirtyGeneration.set(path, (dirtyGeneration.get(path) ?? 0) + 1);
}

export async function ensureSemanticIndex(
  path: string,
  pages: PageText[],
  externalSignal?: AbortSignal,
): Promise<void> {
  if (!docCache.has(path)) return;

  for (let attempt = 0; attempt < MAX_EMBED_BUILD_ATTEMPTS + 1; attempt++) {
    throwIfAborted(externalSignal);
    if (!docCache.has(path)) return;

    const pending = buildPromises.get(path);
    if (pending) {
      await pending;
      if (!docCache.has(path)) return;
      continue;
    }

    const settings = await loadSettings();
    if (!isEmbeddingCapableProvider(settings.provider)) {
      if (import.meta.env.DEV && !warnedNoEmbed.has(settings.provider)) {
        warnedNoEmbed.add(settings.provider);
        console.warn(
          `[semantic-index] provider "${settings.provider}" has no embeddings endpoint; retrieval is keyword-only.`,
        );
      }
      store.delete(path);
      dirty.delete(path);
      failedBuildAttempts.delete(path);
      return;
    }

    const modelKey = embeddingModelKey(settings);
    const existing = store.get(path);
    if (existing && existing.model === modelKey && !dirty.has(path)) return;

    const dirtyGenAtStart = dirtyGeneration.get(path) ?? 0;

    let build!: Promise<void>;
    build = (async () => {
      try {
        if (!docCache.has(path)) return;

        const snapshot = resolvePages(path, pages);
        const sparse = snapshot.filter((p) => p.text.trim().length >= MIN_INDEX_CHARS);
        if (sparse.length === 0) {
          store.delete(path);
          if ((dirtyGeneration.get(path) ?? 0) === dirtyGenAtStart) {
            dirty.delete(path);
          }
          failedBuildAttempts.delete(path);
          return;
        }

        const values = sparse.map((p) => pageEmbedText(p.text, p.page));
        buildAbortByPath.get(path)?.abort();
        const buildAbort = new AbortController();
        buildAbortByPath.set(path, buildAbort);
        const embedSignal = externalSignal
          ? AbortSignal.any([buildAbort.signal, externalSignal])
          : buildAbort.signal;
        const pageOffset = embedWindowOffset.get(path) ?? 0;
        const { embeddings: vectors, capped, eligible, embedded, nextPageOffset } =
          await embedTexts(settings, values, {
            signal: embedSignal,
            pageOffset,
          });
        if (buildAbortByPath.get(path) === buildAbort) {
          buildAbortByPath.delete(path);
        }
        if (capped && nextPageOffset != null) {
          embedWindowOffset.set(path, nextPageOffset);
        } else if (!capped) {
          embedWindowOffset.delete(path);
        }
        if (!docCache.has(path)) return;

        if (capped) {
          embedCapHandler?.(path, { embedded, eligible });
        }
        const priorEntry = store.get(path);
        const priorEntries =
          priorEntry?.model === modelKey ? priorEntry.entries : undefined;
        const freshEntries: PageEmbedding[] = [];
        let dim = priorEntry?.model === modelKey ? priorEntry.dim : 0;
        for (let i = 0; i < sparse.length; i++) {
          const vector = vectors[i];
          if (vector && vector.length > 0) {
            freshEntries.push({ page: sparse[i]!.page, vector });
            dim = vector.length;
          }
        }
        const merged = mergePageEmbeddings(priorEntries, freshEntries);
        const aborted = embedSignal.aborted;
        const complete = merged.length >= sparse.length;
        if (merged.length > 0 && !aborted) {
          store.set(path, { model: modelKey, dim, entries: merged });
        } else if (!priorEntries?.length) {
          store.delete(path);
        }
        if (aborted) {
          if (docCache.has(path)) markSemanticIndexDirty(path);
        } else if (!complete) {
          if (merged.length > 0) {
            failedBuildAttempts.delete(path);
            if (docCache.has(path)) markSemanticIndexDirty(path);
          } else {
            const fails = (failedBuildAttempts.get(path) ?? 0) + 1;
            failedBuildAttempts.set(path, fails);
            if (fails >= MAX_EMBED_BUILD_ATTEMPTS) {
              store.delete(path);
              dirty.delete(path);
            } else if (docCache.has(path)) {
              markSemanticIndexDirty(path);
            }
          }
        } else {
          failedBuildAttempts.delete(path);
          embedWindowOffset.delete(path);
          if ((dirtyGeneration.get(path) ?? 0) === dirtyGenAtStart) {
            dirty.delete(path);
          }
        }
      } finally {
        if (buildPromises.get(path) === build) {
          buildPromises.delete(path);
        }
      }
    })();

    if (buildPromises.has(path)) continue;
    buildPromises.set(path, build);
    await build;

    if (!docCache.has(path)) return;
    if (!dirty.has(path)) return;
    if ((failedBuildAttempts.get(path) ?? 0) >= MAX_EMBED_BUILD_ATTEMPTS) return;
  }
}

export async function semanticSearchPages(
  path: string,
  pages: PageText[],
  query: string,
  limit = 30,
  options?: { signal?: AbortSignal },
): Promise<SearchHit[]> {
  const signal = options?.signal ?? getAgentRunAbortSignal();
  throwIfAborted(signal);

  const livePages = resolvePages(path, pages);
  const keywordHits = searchDocumentPages(livePages, query, limit);
  await ensureSemanticIndex(path, livePages, signal);
  throwIfAborted(signal);
  const indexed = store.get(path);
  if (!indexed?.entries.length) return keywordHits;

  const settings = await loadSettings();
  // Guard: index built by a different embedding model — invalidate and fall back.
  if (embeddingModelKey(settings) !== indexed.model) {
    markSemanticIndexDirty(path);
    return keywordHits;
  }

  throwIfAborted(signal);
  const queryVector = await embedText(settings, query, { signal });
  if (!queryVector) return keywordHits;
  // Dimension guard: mismatched dims make cosine meaningless (silent 0). Rebuild next call.
  if (queryVector.length !== indexed.dim) {
    markSemanticIndexDirty(path);
    return keywordHits;
  }

  const pageText = new Map(livePages.map((p) => [p.page, p.text]));

  // Dedupe by page (keep best score) BEFORE the top-k cutoff so duplicate page
  // entries can't consume the limit.
  const bestByPage = new Map<number, number>();
  for (const entry of indexed.entries) {
    if (entry.vector.length !== queryVector.length) continue;
    const score = cosineSimilarity(queryVector, entry.vector);
    const prev = bestByPage.get(entry.page);
    if (prev === undefined || score > prev) bestByPage.set(entry.page, score);
  }
  if (bestByPage.size === 0) return keywordHits;

  const scored = [...bestByPage.entries()]
    .map(([page, score]) => ({ page, score }))
    .sort((a, b) => b.score - a.score);

  // Relative cutoff (gap-from-best) with an absolute floor, replacing the old fixed 0.25 gate.
  const best = scored[0]!.score;
  const cutoff = Math.max(SCORE_FLOOR, best - RELATIVE_GAP);

  const semanticHits: RankableHit[] = scored
    .filter((s) => s.score >= cutoff)
    .slice(0, limit)
    .map((s) => {
      const snippet = (pageText.get(s.page) ?? "")
        .trim()
        .slice(0, 120)
        .replace(/\s+/g, " ");
      return {
        page: s.page,
        index: 0,
        match: query,
        snippet: snippet ? `…${snippet}…` : `Page ${s.page}`,
        semanticScore: s.score,
      };
    });

  const seen = new Set<string>();
  const merged: RankableHit[] = [];
  for (const hit of [...semanticHits, ...keywordHits]) {
    const key = `${hit.page}:${hit.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
    if (merged.length >= limit) break;
  }

  return rerankSearchHits(query, fuseSearchHits(query, merged, pageText, limit), pageText, limit);
}
