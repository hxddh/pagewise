import { getToolName, isToolUIPart, type UIMessage } from "ai";

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;
type MessagePart = UIMessage["parts"][number];
type ToolPart = Extract<MessagePart, { type: string }> & Record<string, unknown>;

export type ToolStepBucket = "search" | "read" | "index" | "other";

export interface ToolStepInfo {
  toolName: string;
  bucket: ToolStepBucket;
  label: string;
  key: string;
  running: boolean;
}

function numArg(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function toolActivityLabel(toolName: string, t: TranslateFn): string {
  switch (toolName) {
    case "read_pdf_page":
    case "read_pdf_range":
      return t("agent.activityReadRange");
    case "get_document_index":
      return t("agent.activityIndex");
    case "search_in_document":
      return t("agent.activitySearch");
    case "list_documents":
      return t("agent.activityList");
    default:
      return t("agent.activityWorking");
  }
}

function toolBucket(toolName: string): ToolStepBucket {
  switch (toolName) {
    case "search_in_document":
      return "search";
    case "read_pdf_page":
    case "read_pdf_range":
      return "read";
    case "get_document_index":
      return "index";
    default:
      return "other";
  }
}

export function toolStepLabel(
  toolName: string,
  input: unknown,
  t: TranslateFn,
): { label: string; key: string; bucket: ToolStepBucket } {
  const args = (input ?? {}) as Record<string, unknown>;
  const bucket = toolBucket(toolName);

  switch (toolName) {
    case "read_pdf_page": {
      const page = numArg(args.page);
      const label =
        page !== undefined
          ? t("agent.toolReadPage", { page })
          : t("agent.activityReadRange");
      return { label, key: `read:${page ?? "?"}`, bucket };
    }
    case "read_pdf_range": {
      const start = numArg(args.start);
      const end = numArg(args.end);
      const label =
        start !== undefined && end !== undefined
          ? t("agent.toolReadRange", { start, end })
          : t("agent.activityReadRange");
      return { label, key: `range:${start ?? "?"}-${end ?? "?"}`, bucket };
    }
    case "search_in_document": {
      const query = typeof args.query === "string" ? args.query : "";
      const label = query ? t("agent.toolSearch", { query }) : t("agent.activitySearch");
      return { label, key: `search:${query}`, bucket };
    }
    case "get_document_index":
      return { label: t("agent.toolIndex"), key: "index", bucket };
    default:
      return { label: t("agent.toolWorking"), key: `other:${toolName}`, bucket: "other" };
  }
}

export function toolStepFromPart(part: ToolPart, t: TranslateFn): ToolStepInfo {
  const toolName = getToolName(part as Parameters<typeof getToolName>[0]);
  const state = (part as { state?: string }).state;
  const running = state !== "output-available" && state !== "output-error";
  const { label, key, bucket } = running
    ? {
        label: toolActivityLabel(toolName, t),
        key: `${toolName}:${(part as { toolCallId?: string }).toolCallId ?? "running"}`,
        bucket: toolBucket(toolName),
      }
    : toolStepLabel(toolName, (part as { input?: unknown }).input, t);
  return { toolName, bucket, label, key, running };
}

export interface ToolStepsSummary {
  /** Use compact fold when true (2+ steps). */
  aggregate: boolean;
  summary: string;
  details: Array<{ label: string; count: number }>;
  anyRunning: boolean;
}

function completedSummary(steps: ToolStepInfo[], t: TranslateFn): string {
  const bucketCounts: Record<ToolStepBucket, number> = {
    search: 0,
    read: 0,
    index: 0,
    other: 0,
  };
  for (const step of steps) bucketCounts[step.bucket] += 1;

  const fragments: string[] = [];
  if (bucketCounts.search > 0) {
    fragments.push(t("agent.toolsSummarySearch", { count: bucketCounts.search }));
  }
  if (bucketCounts.read > 0) {
    fragments.push(t("agent.toolsSummaryRead", { count: bucketCounts.read }));
  }
  if (bucketCounts.index > 0) {
    fragments.push(
      bucketCounts.index === 1
        ? t("agent.toolIndex")
        : t("agent.toolsSummaryIndex", { count: bucketCounts.index }),
    );
  }
  if (bucketCounts.other > 0) {
    fragments.push(t("agent.toolsSummaryOther", { count: bucketCounts.other }));
  }
  if (fragments.length > 0) return fragments.join(t("agent.toolsSummarySep"));
  return t("agent.toolsSummarySteps", { count: steps.length });
}

export function summarizeToolSteps(steps: ToolStepInfo[], t: TranslateFn): ToolStepsSummary {
  const detailsMap = new Map<string, { label: string; count: number }>();

  for (const step of steps) {
    const existing = detailsMap.get(step.key);
    if (existing) existing.count += 1;
    else detailsMap.set(step.key, { label: step.label, count: 1 });
  }

  const details = [...detailsMap.values()];
  const anyRunning = steps.some((s) => s.running);
  const doneSteps = steps.filter((s) => !s.running);
  const runningStep = steps.find((s) => s.running);

  if (anyRunning) {
    const doneSummary = doneSteps.length > 0 ? completedSummary(doneSteps, t) : null;
    const runningLabel = runningStep
      ? toolActivityLabel(runningStep.toolName, t)
      : t("agent.activityWorking");
    return {
      aggregate: true,
      summary: doneSummary ? `${doneSummary} · ${runningLabel}` : runningLabel,
      details,
      anyRunning: true,
    };
  }

  if (steps.length <= 1) {
    const only = steps[0];
    return {
      aggregate: false,
      summary: only?.label ?? "",
      details,
      anyRunning: false,
    };
  }

  return {
    aggregate: true,
    summary: completedSummary(steps, t),
    details,
    anyRunning: false,
  };
}

/** Agent loop inserts step-start between tool rounds — skip when batching tool UI. */
function isStructuralPart(part: MessagePart): boolean {
  return part.type === "step-start";
}

export type MessageRenderSegment =
  | { kind: "part"; part: MessagePart; index: number }
  | { kind: "tools"; parts: Array<{ part: ToolPart; index: number }> };

export function segmentMessageParts(parts: UIMessage["parts"]): MessageRenderSegment[] {
  const segments: MessageRenderSegment[] = [];
  let toolBatch: Array<{ part: ToolPart; index: number }> = [];

  const flushTools = () => {
    if (toolBatch.length === 0) return;
    segments.push({ kind: "tools", parts: toolBatch });
    toolBatch = [];
  };

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (isStructuralPart(part)) continue;
    if (isToolUIPart(part)) {
      toolBatch.push({ part: part as ToolPart, index });
      continue;
    }
    flushTools();
    segments.push({ kind: "part", part, index });
  }
  flushTools();
  return segments;
}
