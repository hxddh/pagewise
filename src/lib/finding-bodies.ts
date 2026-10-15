/**
 * The reader's kept answers, one file per finding.
 *
 * A finding is a claim, its evidence and — when the reader keeps a whole answer
 * — the answer itself, up to 20,000 characters. All of it used to live in
 * `findings.json`, one document array per file: at the store's caps (5,000
 * findings across documents) the file measured ~104 MB, and *every* edit
 * rewrote all of it on a 400 ms debounce. Keeping one answer re-serialised the
 * four thousand others with it.
 *
 * So the body moves out. `findings.json` keeps the index — claim, evidence,
 * pages, flags — and each body gets its own file under `finding-bodies/`, named
 * by the finding's id. A body edit then writes one ~20 KB file instead of
 * ~104 MB, and the index a flush rewrites is the part that is actually shared.
 *
 * Three rules keep the two copies honest:
 *
 *   - the index holds a body only while the sidecar does not. `externalize`
 *     writes the bodies first and strips them from what it returns, so a crash
 *     between the two writes leaves a body nothing points at, never a finding
 *     pointing at nothing;
 *   - a body that is already beside the index is never re-written. `stored` is
 *     only ids this session has read or written, so a session's first flush
 *     costs one file per body at most — not one per body per flush;
 *   - an inline body in a document this session has not opened is left exactly
 *     where it is. Old files keep loading, and the move happens the first time
 *     their document is opened (that is `hydrateBodies`), so upgrading never
 *     rewrites a store the reader did not touch.
 *
 * Nothing here decides what a body means; the store does. This module only
 * knows ids, bytes and the two places they may be.
 */
import {
  BODIES_DIR,
  bodyFileName,
  deleteStoreFiles,
  listStoreDir,
  readStoreFile,
  writeStoreFile,
} from "./atomic-store";
import type { Finding } from "./finding-store";

/** Ids whose body this session has read from, or written to, the sidecar. */
const stored = new Set<string>();
/** Ids whose body has to be written there: new, or moved out of the index. */
const pending = new Set<string>();

const ID_SUFFIX = ".json";

function idOf(name: string): string {
  return name.slice(BODIES_DIR.length + 1, -ID_SUFFIX.length);
}

/** Remember that a finding's body must reach the sidecar. */
export function markBodyPending(id: string): void {
  pending.add(id);
}

/**
 * Attach the bodies already kept beside the index, and mark the ones that still
 * have to move out of it.
 *
 * Called when a document is loaded, which is the moment its record is read —
 * and the moment its inline bodies (written before the split) are worth moving.
 * A sidecar that cannot be read is not an error: the document opens with what
 * the index has, exactly as it would have before the split.
 */
export async function hydrateBodies(findings: Finding[]): Promise<Finding[]> {
  try {
    const present = new Set((await listStoreDir(BODIES_DIR)).map(idOf));
    const wanted = findings.filter((f) => present.has(f.id));
    const bodies = new Map<string, string>();
    // Chunked so a document with hundreds of kept answers does not open with
    // hundreds of concurrent IPC calls.
    for (let i = 0; i < wanted.length; i += 8) {
      const chunk = wanted.slice(i, i + 8);
      const texts = await Promise.all(chunk.map((f) => readStoreFile(bodyFileName(f.id))));
      for (let j = 0; j < chunk.length; j += 1) {
        const raw = texts[j];
        if (typeof raw !== "string") continue;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed !== "string") continue;
          bodies.set(chunk[j]!.id, parsed);
          stored.add(chunk[j]!.id);
        } catch {
          // A body file that cannot be parsed is not a body: the index's copy,
          // if it still has one, stays the authoritative one.
        }
      }
    }
    return findings.map((f) => {
      const body = bodies.get(f.id);
      if (body !== undefined) return { ...f, body };
      if (f.body) pending.add(f.id);
      return f;
    });
  } catch {
    return findings;
  }
}

/**
 * Write the bodies a flush is about to store, and return the documents as the
 * index should hold them: without the bodies that are now beside it.
 */
export async function externalizeBodies<T extends { findings: Finding[] }>(docs: T[]): Promise<T[]> {
  const writes: [string, string][] = [];
  for (const doc of docs) {
    for (const finding of doc.findings) {
      if (!finding.body) continue;
      if (stored.has(finding.id)) continue;
      if (!pending.has(finding.id)) continue;
      writes.push([finding.id, finding.body]);
    }
  }
  for (let i = 0; i < writes.length; i += 8) {
    await Promise.all(
      writes
        .slice(i, i + 8)
        .map(([id, body]) => writeStoreFile(bodyFileName(id), JSON.stringify(body))),
    );
  }
  for (const [id] of writes) {
    stored.add(id);
    pending.delete(id);
  }
  return docs.map((doc) => ({
    ...doc,
    findings: doc.findings.map((f) => (stored.has(f.id) ? withoutBody(f) : f)),
  }));
}

/** Drop the bodies no kept document references any more. */
export async function pruneBodies<T extends { findings: Finding[] }>(docs: T[]): Promise<void> {
  const keep = new Set<string>();
  for (const doc of docs) for (const finding of doc.findings) keep.add(finding.id);
  const names = await listStoreDir(BODIES_DIR);
  const orphans = names.filter((name) => !keep.has(idOf(name)));
  if (orphans.length === 0) return;
  await deleteStoreFiles(orphans);
  for (const name of orphans) {
    const id = idOf(name);
    stored.delete(id);
    pending.delete(id);
  }
}

function withoutBody(finding: Finding): Finding {
  const { body: _stored, ...rest } = finding;
  return rest;
}

/** Test seam — forget what this session knows about the sidecar. */
export function __resetFindingBodiesForTests(): void {
  stored.clear();
  pending.clear();
}
