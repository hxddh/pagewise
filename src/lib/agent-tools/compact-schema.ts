import { asSchema, jsonSchema, type ToolSet } from "ai";
import type { JSONSchema7 } from "ai";

/**
 * Take the bytes out of every tool's JSON Schema that the provider never acts
 * on.
 *
 * The tool block is re-sent on every step of every run, and two things in it
 * cost bytes while deciding nothing:
 *
 * - `$schema` — 46 bytes per tool, 368 across the eight. It declares the JSON
 *   Schema dialect; OpenAI's function `parameters` is a fixed dialect and the
 *   field is advisory, not a constraint.
 * - `maximum: 9007199254740991`, and the matching negative `minimum` — Zod
 *   writes the safe-integer bound for every `.int()`, ten times across the tool
 *   block, about 270 bytes. A JSON number cannot exceed 2^53, so the constraint
 *   cannot fail; it is the absence of a bound written out the long way.
 *
 * What does NOT change is validation. The schema the SDK validates a tool call
 * against is still the Zod one — `validate` here delegates straight to it — so
 * a page of `0` is still refused as an `InvalidToolInputError` the model can
 * correct. This only prunes the copy that goes over the wire, which
 * `agent-tool-prefix.test.ts` holds to a 9,000-byte budget.
 */

/** The bound Zod writes for `.int()` when no explicit one is given. */
const SAFE_INT = 9_007_199_254_740_991;

/** A copy of `node` without `$schema` or the safe-integer sentinel bounds. */
function prune(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(prune);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$schema") continue;
    if (key === "maximum" && value === SAFE_INT) continue;
    if (key === "minimum" && value === -SAFE_INT) continue;
    out[key] = prune(value);
  }
  return out;
}

/**
 * The same tools, with their prompt-visible schemas pruned.
 *
 * Applied once, at assembly, so a tool added later cannot quietly reintroduce
 * the bytes — the same reason the digest test pins every definition rather than
 * the ones that happened to be long.
 */
export function compactToolSchemas<T extends ToolSet>(tools: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(tools)) {
    const original = asSchema((entry as { inputSchema?: unknown }).inputSchema as never);
    out[name] = {
      ...(entry as object),
      inputSchema: jsonSchema(
        async () => prune(await original.jsonSchema) as JSONSchema7,
        {
          // Undefined only when the wrapped schema has no validation of its
          // own; every tool here is Zod, which always has it.
          validate: (value) =>
            original.validate?.(value) ?? { success: true as const, value },
        },
      ),
    };
  }
  return out as T;
}
