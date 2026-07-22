import { pricingRate } from "./pricing.js";
import { redactIdentifier, redactSpan, redactString } from "./redact.js";
import { SENSITIVE_TRACE_ID, type InternalSpan } from "./internal.js";
import type {
  AnalysisReport,
  CostSummary,
  LoopFinding,
  NormalizedSpan,
  PricingFile,
  RecoveryLedgerEntry,
  RecoverySpanEvidence,
  TraceSummary,
  UsageRow,
} from "./types.js";

export interface AnalyzeOptions {
  title?: string;
  source?: string;
  redact?: boolean;
  pricing?: PricingFile;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareIdPaths(left: string[], right: string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareText(left[index] as string, right[index] as string);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function compareSpans(a: NormalizedSpan, b: NormalizedSpan): number {
  return compareText(a.traceId, b.traceId) || a.startMs - b.startMs || compareText(a.name, b.name) || compareText(a.id, b.id);
}

function round(value: number, places = 3): number {
  const multiplier = 10 ** places;
  if (!Number.isFinite(value)) throw new Error("Analysis produced a non-finite number");
  if (Math.abs(value) > Number.MAX_VALUE / multiplier) return value;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function quantile(values: number[], value: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(value * sorted.length) - 1);
  return round(sorted[index] ?? 0);
}

function addSafeInteger(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds JavaScript's safe integer range`);
  return result;
}

function sumSafeIntegers(values: number[], label: string): number {
  return values.reduce((sum, value) => addSafeInteger(sum, value, label), 0);
}

function signature(span: NormalizedSpan): string {
  return `${span.kind}:${span.tool ?? span.model ?? span.name}`.toLowerCase();
}

function canonicalOperationPart(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/gu, " ").toLowerCase();
  return normalized.length === 0 ? undefined : normalized;
}

function stringAttribute(span: NormalizedSpan, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(span.attributes, key)) return undefined;
  const value = span.attributes[key];
  if (typeof value === "string") return canonicalOperationPart(value);
  if (typeof value === "number" || typeof value === "boolean") return canonicalOperationPart(String(value));
  return undefined;
}

/**
 * Recovery matching intentionally excludes name-only spans. Tool identity and
 * model + operation identity are the smallest stable signatures normalized by
 * the adapter without relying on arguments, prompts, or other sensitive data.
 */
function stableOperationSignature(span: NormalizedSpan): string | undefined {
  if (span.kind === "tool" && span.tool !== undefined) {
    const tool = canonicalOperationPart(span.tool);
    if (tool === undefined) return undefined;
    const operation = stringAttribute(span, "gen_ai.operation.name");
    return operation === undefined ? `tool:${tool}` : `tool:${tool}:${operation}`;
  }
  if (span.kind === "model" && span.model !== undefined) {
    const model = canonicalOperationPart(span.model);
    const operation = stringAttribute(span, "gen_ai.operation.name") ?? canonicalOperationPart(span.name);
    if (model === undefined || operation === undefined) return undefined;
    return `model:${model}:${operation}`;
  }
  return undefined;
}

function hasUsableRecoveryTiming(span: NormalizedSpan): boolean {
  if (span.endMs < span.startMs) return false;
  return span.startMs !== 0 || span.endMs !== 0 || span.durationMs !== 0;
}

function estimateSpanCost(span: NormalizedSpan, pricing?: PricingFile): number | undefined {
  const tokens = addSafeInteger(span.inputTokens, span.outputTokens, `Token count for span ${span.id}`);
  if (tokens === 0 || pricing === undefined || span.model === undefined) return undefined;
  const rate = pricingRate(pricing, span.model);
  if (rate === undefined) return undefined;
  const cost = span.inputTokens * rate.inputPerMillion / 1_000_000 + span.outputTokens * rate.outputPerMillion / 1_000_000;
  if (!Number.isFinite(cost)) throw new Error(`Recovery cost estimate overflow for model ${JSON.stringify(span.model)}`);
  return round(cost, 8);
}

function recoveryEvidence(span: NormalizedSpan, pricing?: PricingFile): RecoverySpanEvidence {
  const hasTokens = span.inputTokens > 0 || span.outputTokens > 0;
  const estimatedCostUsd = estimateSpanCost(span, pricing);
  return {
    spanId: span.id,
    status: span.status,
    durationMs: span.durationMs,
    ...(hasTokens ? { inputTokens: span.inputTokens, outputTokens: span.outputTokens } : {}),
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  };
}

interface RecoveryResult {
  ledger: RecoveryLedgerEntry[];
  skippedParallelGroups: number;
  skippedTimingGroups: number;
}

function findRecoveryLedger(spans: NormalizedSpan[], pricing?: PricingFile): RecoveryResult {
  const groups = new Map<string, { traceId: string; parentSpanId: string; operationSignature: string; spans: NormalizedSpan[] }>();
  for (const span of spans) {
    if (span.parentId === undefined || span.parentId.length === 0) continue;
    const operationSignature = stableOperationSignature(span);
    if (operationSignature === undefined) continue;
    const key = JSON.stringify([span.traceId, span.parentId, operationSignature]);
    const group = groups.get(key) ?? { traceId: span.traceId, parentSpanId: span.parentId, operationSignature, spans: [] };
    group.spans.push(span);
    groups.set(key, group);
  }

  const ledger: RecoveryLedgerEntry[] = [];
  let skippedParallelGroups = 0;
  let skippedTimingGroups = 0;
  const orderedGroups = [...groups.values()].sort((a, b) =>
    compareText(a.traceId, b.traceId) || compareText(a.parentSpanId, b.parentSpanId) || compareText(a.operationSignature, b.operationSignature));
  for (const group of orderedGroups) {
    if (group.spans.length < 2 || !group.spans.some((span) => span.status === "error")) continue;
    const ordered = [...group.spans].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || compareText(a.id, b.id));
    if (ordered.some((span) => !hasUsableRecoveryTiming(span))) {
      skippedTimingGroups += 1;
      continue;
    }
    let latestEnd = Number.NEGATIVE_INFINITY;
    let previousStart: number | undefined;
    let overlaps = false;
    for (const span of ordered) {
      if (span.startMs < latestEnd || (previousStart !== undefined && span.startMs === previousStart)) {
        overlaps = true;
        break;
      }
      latestEnd = Math.max(latestEnd, span.endMs);
      previousStart = span.startMs;
    }
    if (overlaps) {
      skippedParallelGroups += 1;
      continue;
    }

    let failed: NormalizedSpan[] = [];
    for (const span of ordered) {
      if (span.status === "error") {
        failed.push(span);
        continue;
      }
      if (failed.length === 0) continue;
      const attempts = failed.map((attempt) => recoveryEvidence(attempt, pricing));
      const recoveredBy = recoveryEvidence(span, pricing);
      const firstFailed = failed[0] as NormalizedSpan;
      const lastFailed = failed[failed.length - 1] as NormalizedSpan;
      const failedDurationMs = round(failed.reduce((total, attempt) => total + attempt.durationMs, 0));
      const allFailedAttemptsHaveTokens = attempts.every((attempt) => attempt.inputTokens !== undefined || attempt.outputTokens !== undefined);
      const failedInputTokens = allFailedAttemptsHaveTokens
        ? sumSafeIntegers(attempts.map((attempt) => attempt.inputTokens ?? 0), "Recovery Ledger input token count")
        : undefined;
      const failedOutputTokens = allFailedAttemptsHaveTokens
        ? sumSafeIntegers(attempts.map((attempt) => attempt.outputTokens ?? 0), "Recovery Ledger output token count")
        : undefined;
      const allFailedAttemptsPriced = attempts.every((attempt) => attempt.estimatedCostUsd !== undefined);
      const estimatedFailedCostUsd = allFailedAttemptsPriced
        ? round(attempts.reduce((total, attempt) => total + (attempt.estimatedCostUsd as number), 0), 8)
        : undefined;
      ledger.push({
        traceId: group.traceId,
        parentSpanId: group.parentSpanId,
        operationSignature: group.operationSignature,
        failedAttempts: attempts,
        recoveredBy,
        failedDurationMs,
        retryDelayMs: round(Math.max(0, span.startMs - lastFailed.endMs)),
        recoveryLatencyMs: round(Math.max(0, span.endMs - firstFailed.endMs)),
        ...(failedInputTokens === undefined ? {} : { failedInputTokens }),
        ...(failedOutputTokens === undefined ? {} : { failedOutputTokens }),
        ...(estimatedFailedCostUsd === undefined ? {} : { estimatedFailedCostUsd }),
      });
      failed = [];
    }
  }
  return { ledger, skippedParallelGroups, skippedTimingGroups };
}

interface PathResult {
  ids: string[];
  duration: number;
}

const MAX_LOOP_FINDINGS = 1_000;
const MAX_LOOP_EVIDENCE_IDS = 100;

function pathComesFirst(candidate: string, current: string | undefined, nextById: Map<string, string>): boolean {
  if (current === undefined) return false;
  let left: string | undefined = candidate;
  let right: string | undefined = current;
  let remaining = nextById.size + 1;
  while (left !== undefined && right !== undefined && remaining > 0) {
    const comparison = compareText(left, right);
    if (comparison !== 0) return comparison < 0;
    left = nextById.get(left);
    right = nextById.get(right);
    remaining -= 1;
  }
  return left === undefined && right !== undefined;
}

function bestPath(rootId: string, byId: Map<string, NormalizedSpan>, children: Map<string, string[]>): PathResult {
  interface Frame { id: string; index: number; bestChild?: string }
  if (!byId.has(rootId)) return { ids: [], duration: 0 };
  const durationById = new Map<string, number>();
  const nextById = new Map<string, string>();
  const visiting = new Set<string>();
  const stack: Frame[] = [{ id: rootId, index: 0 }];
  visiting.add(rootId);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    const childIds = children.get(frame.id) ?? [];
    if (frame.index < childIds.length) {
      const child = childIds[frame.index] as string;
      if (visiting.has(child)) {
        frame.index += 1;
        continue;
      }
      const childDuration = durationById.get(child);
      if (childDuration === undefined) {
        visiting.add(child);
        stack.push({ id: child, index: 0 });
        continue;
      }
      const currentDuration = frame.bestChild === undefined ? 0 : durationById.get(frame.bestChild) ?? 0;
      if (childDuration > currentDuration || (childDuration === currentDuration && pathComesFirst(child, frame.bestChild, nextById))) {
        frame.bestChild = child;
      }
      frame.index += 1;
      continue;
    }

    const span = byId.get(frame.id) as NormalizedSpan;
    const childDuration = frame.bestChild === undefined ? 0 : durationById.get(frame.bestChild) ?? 0;
    durationById.set(frame.id, round(span.durationMs + childDuration));
    if (frame.bestChild !== undefined) nextById.set(frame.id, frame.bestChild);
    visiting.delete(frame.id);
    stack.pop();
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = rootId;
  while (current !== undefined && !seen.has(current)) {
    ids.push(current);
    seen.add(current);
    current = nextById.get(current);
  }
  return { ids, duration: durationById.get(rootId) ?? 0 };
}

function reachable(root: string, children: Map<string, string[]>, visited: Set<string>): void {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    const childIds = children.get(current) ?? [];
    for (let index = childIds.length - 1; index >= 0; index -= 1) stack.push(childIds[index] as string);
  }
}

function buildTrace(traceId: string, spans: NormalizedSpan[]): TraceSummary {
  const byId = new Map(spans.map((span) => [span.id, span]));
  const children = new Map<string, string[]>();
  for (const span of spans) {
    if (span.parentId === undefined || span.parentId === span.id || !byId.has(span.parentId)) continue;
    const bucket = children.get(span.parentId) ?? [];
    bucket.push(span.id);
    children.set(span.parentId, bucket);
  }
  for (const bucket of children.values()) bucket.sort((a, b) => compareSpans(byId.get(a) as NormalizedSpan, byId.get(b) as NormalizedSpan));
  const roots = spans.filter((span) => span.parentId === undefined || span.parentId === span.id || !byId.has(span.parentId)).map((span) => span.id);
  const visited = new Set<string>();
  for (const root of roots) reachable(root, children, visited);
  for (const span of spans) {
    if (!visited.has(span.id)) {
      roots.push(span.id);
      reachable(span.id, children, visited);
    }
  }
  roots.sort((a, b) => compareSpans(byId.get(a) as NormalizedSpan, byId.get(b) as NormalizedSpan));
  let critical: PathResult = { ids: [], duration: 0 };
  for (const root of roots) {
    const candidate = bestPath(root, byId, children);
    if (candidate.duration > critical.duration || (candidate.duration === critical.duration && compareIdPaths(candidate.ids, critical.ids) < 0)) critical = candidate;
  }
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    start = Math.min(start, span.startMs);
    end = Math.max(end, span.endMs);
  }
  return {
    id: traceId,
    rootIds: roots,
    spanIds: spans.map((span) => span.id),
    startMs: start,
    endMs: end,
    durationMs: round(Math.max(0, end - start)),
    criticalPath: critical.ids,
    criticalPathMs: critical.duration,
  };
}

function findLoops(spans: NormalizedSpan[]): { loops: LoopFinding[]; retries: number; truncated: boolean } {
  const byTrace = new Map<string, NormalizedSpan[]>();
  for (const span of spans) (byTrace.get(span.traceId) ?? byTrace.set(span.traceId, []).get(span.traceId) as NormalizedSpan[]).push(span);
  const findings: LoopFinding[] = [];
  let retries = 0;
  let truncated = false;
  for (const [traceId, traceSpans] of [...byTrace.entries()].sort(([a], [b]) => compareText(a, b))) {
    const groups = new Map<string, NormalizedSpan[]>();
    for (const span of traceSpans) {
      const key = JSON.stringify([span.parentId ?? null, signature(span)]);
      const group = groups.get(key) ?? [];
      group.push(span);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      group.sort(compareSpans);
      retries += Math.max(0, group.length - 1);
      if (group.length >= 3) {
        if (findings.length < MAX_LOOP_FINDINGS) {
          findings.push({ traceId, signature: signature(group[0] as NormalizedSpan), spanIds: group.slice(0, MAX_LOOP_EVIDENCE_IDS).map((span) => span.id), reason: "repeated siblings" });
        } else {
          truncated = true;
        }
        if (group.length > MAX_LOOP_EVIDENCE_IDS) truncated = true;
      }
    }

    const ordered = [...traceSpans].sort(compareSpans);
    const byId = new Map(ordered.map((span) => [span.id, span]));
    const children = new Map<string, string[]>();
    for (const span of ordered) {
      if (span.parentId === undefined || span.parentId === span.id || !byId.has(span.parentId)) continue;
      const bucket = children.get(span.parentId) ?? [];
      bucket.push(span.id);
      children.set(span.parentId, bucket);
    }
    for (const bucket of children.values()) bucket.sort((a, b) => compareSpans(byId.get(a) as NormalizedSpan, byId.get(b) as NormalizedSpan));
    const roots = ordered.filter((span) => span.parentId === undefined || span.parentId === span.id || !byId.has(span.parentId)).map((span) => span.id);
    const completed = new Set<string>();

    const walk = (root: string): void => {
      interface WalkFrame { id: string; exit: boolean }
      const stack: WalkFrame[] = [{ id: root, exit: false }];
      const activeIds = new Set<string>();
      const path: string[] = [];
      const positions = new Map<string, number[]>();
      while (stack.length > 0) {
        const frame = stack.pop() as WalkFrame;
        const current = byId.get(frame.id);
        if (current === undefined) continue;
        const sig = signature(current);
        if (frame.exit) {
          const indexes = positions.get(sig);
          indexes?.pop();
          if (indexes?.length === 0) positions.delete(sig);
          path.pop();
          activeIds.delete(frame.id);
          completed.add(frame.id);
          continue;
        }
        if (completed.has(frame.id) || activeIds.has(frame.id)) continue;
        const earlier = positions.get(sig)?.at(-1);
        if (earlier !== undefined) {
          if (findings.length < MAX_LOOP_FINDINGS) {
            const evidenceStart = Math.max(earlier, path.length - (MAX_LOOP_EVIDENCE_IDS - 1));
            findings.push({ traceId, signature: sig, spanIds: [...path.slice(evidenceStart), frame.id], reason: "recursive path" });
            if (evidenceStart > earlier) truncated = true;
          } else {
            truncated = true;
          }
        }
        const indexes = positions.get(sig) ?? [];
        indexes.push(path.length);
        positions.set(sig, indexes);
        path.push(frame.id);
        activeIds.add(frame.id);
        stack.push({ id: frame.id, exit: true });
        const childIds = children.get(frame.id) ?? [];
        for (let index = childIds.length - 1; index >= 0; index -= 1) {
          const child = childIds[index] as string;
          if (!activeIds.has(child)) stack.push({ id: child, exit: false });
        }
      }
    };

    for (const root of roots) if (!completed.has(root)) walk(root);
    for (const span of ordered) if (!completed.has(span.id)) walk(span.id);
  }
  const unique = new Map<string, LoopFinding>();
  for (const finding of findings) unique.set(JSON.stringify([finding.traceId, finding.reason, finding.signature, finding.spanIds]), finding);
  return { loops: [...unique.values()].sort((a, b) => compareText(a.traceId, b.traceId) || compareText(a.signature, b.signature) || compareIdPaths(a.spanIds, b.spanIds)), retries, truncated };
}

function usageRows(spans: NormalizedSpan[], pricing?: PricingFile): { rows: UsageRow[]; cost?: CostSummary } {
  const rows = new Map<string, UsageRow>();
  for (const span of spans) {
    if (span.kind !== "model" && span.kind !== "tool") continue;
    const name = span.kind === "model" ? span.model ?? span.name : span.tool ?? span.name;
    const key = `${span.kind}\0${name}`;
    const row = rows.get(key) ?? { type: span.kind, name, calls: 0, errors: 0, durationMs: 0, inputTokens: 0, outputTokens: 0 };
    row.calls += 1;
    row.errors += span.status === "error" ? 1 : 0;
    row.durationMs = round(row.durationMs + span.durationMs);
    row.inputTokens = addSafeInteger(row.inputTokens, span.inputTokens, "Aggregated input token count");
    row.outputTokens = addSafeInteger(row.outputTokens, span.outputTokens, "Aggregated output token count");
    rows.set(key, row);
  }
  let estimatedUsd = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  const result = [...rows.values()].sort((a, b) => compareText(a.type, b.type) || b.calls - a.calls || compareText(a.name, b.name));
  if (pricing !== undefined) {
    for (const row of result) {
      if (row.type !== "model") continue;
      const rate = pricingRate(pricing, row.name);
      const tokens = row.inputTokens + row.outputTokens;
      if (!Number.isSafeInteger(tokens)) throw new Error("Aggregated model token count exceeds JavaScript's safe integer range");
      if (rate === undefined) {
        unpricedTokens = addSafeInteger(unpricedTokens, tokens, "Unpriced token count");
        continue;
      }
      const rowCost = row.inputTokens * rate.inputPerMillion / 1_000_000 + row.outputTokens * rate.outputPerMillion / 1_000_000;
      if (!Number.isFinite(rowCost)) throw new Error(`Cost estimate overflow for model ${JSON.stringify(row.name)}`);
      row.estimatedCostUsd = round(rowCost, 8);
      estimatedUsd += rowCost;
      if (!Number.isFinite(estimatedUsd)) throw new Error("Total cost estimate overflowed");
      pricedTokens = addSafeInteger(pricedTokens, tokens, "Priced token count");
    }
    return {
      rows: result,
      cost: { currency: "USD", estimatedUsd: round(estimatedUsd, 8), pricedTokens, unpricedTokens, source: "local pricing file" },
    };
  }
  return { rows: result };
}

function reproducibleTimestamp(spans: NormalizedSpan[]): string {
  let latest = Number.NEGATIVE_INFINITY;
  for (const span of spans) latest = Math.max(latest, span.endMs);
  return latest >= 946_684_800_000 && latest <= 8_640_000_000_000_000 ? new Date(latest).toISOString() : "1970-01-01T00:00:00.000Z";
}

function validateSpans(spans: NormalizedSpan[]): void {
  const ids = new Set<string>();
  for (const span of spans) {
    if (typeof span.id !== "string" || span.id.length === 0) throw new Error("Every span must have a non-empty string id");
    if (ids.has(span.id)) throw new Error(`Duplicate normalized span id: ${span.id}`);
    ids.add(span.id);
    if (typeof span.traceId !== "string" || span.traceId.length === 0) throw new Error(`Span ${span.id} must have a non-empty traceId`);
    if (!(span.status === "ok" || span.status === "error" || span.status === "unset")) throw new Error(`Span ${span.id} has an invalid status`);
    for (const [name, value] of [["startMs", span.startMs], ["endMs", span.endMs], ["durationMs", span.durationMs]] as const) {
      if (!Number.isFinite(value)) throw new Error(`Span ${span.id} has a non-finite ${name}`);
    }
    if (span.durationMs < 0) throw new Error(`Span ${span.id} has a negative durationMs`);
    for (const [name, value] of [["inputTokens", span.inputTokens], ["outputTokens", span.outputTokens]] as const) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Span ${span.id} has an invalid ${name}`);
    }
  }
}

export function analyzeSpans(inputSpans: NormalizedSpan[], options: AnalyzeOptions = {}): AnalysisReport {
  if (inputSpans.length === 0) throw new Error("Cannot analyze an empty span list");
  validateSpans(inputSpans);
  const spans = [...inputSpans].sort(compareSpans);
  const traceGroups = new Map<string, NormalizedSpan[]>();
  for (const span of spans) {
    const bucket = traceGroups.get(span.traceId) ?? [];
    bucket.push(span);
    traceGroups.set(span.traceId, bucket);
  }
  const traces = [...traceGroups.entries()].sort(([a], [b]) => compareText(a, b)).map(([id, traceSpans]) => buildTrace(id, traceSpans));
  const loopResult = findLoops(spans);
  const usageResult = usageRows(spans, options.pricing);
  const recoveryResult = findRecoveryLedger(spans, options.pricing);
  const knownIds = new Map<string, Set<string>>();
  for (const span of spans) {
    const ids = knownIds.get(span.traceId) ?? new Set<string>();
    ids.add(span.id);
    knownIds.set(span.traceId, ids);
  }
  const orphanCount = spans.filter((span) => span.parentId !== undefined && !(knownIds.get(span.traceId)?.has(span.parentId) ?? false)).length;
  const zeroTiming = spans.filter((span) => span.startMs === 0 && span.durationMs === 0).length;
  const warnings: string[] = [];
  if (orphanCount > 0) warnings.push(`${orphanCount} span(s) reference a missing parent and were treated as roots.`);
  if (zeroTiming > 0) warnings.push(`${zeroTiming} span(s) have no usable timing information.`);
  if (usageResult.cost !== undefined && usageResult.cost.unpricedTokens > 0) warnings.push(`${usageResult.cost.unpricedTokens} model token(s) remain unpriced because no local rate matched.`);
  if (loopResult.truncated) warnings.push(`Loop evidence was limited to ${MAX_LOOP_FINDINGS} findings and ${MAX_LOOP_EVIDENCE_IDS} span IDs per finding.`);
  if (recoveryResult.skippedParallelGroups > 0) warnings.push(`Recovery Ledger omitted ${recoveryResult.skippedParallelGroups} operation group(s) with overlapping or simultaneous sibling spans.`);
  if (recoveryResult.skippedTimingGroups > 0) warnings.push(`Recovery Ledger omitted ${recoveryResult.skippedTimingGroups} operation group(s) without usable timing evidence.`);
  const redact = options.redact ?? true;
  const sensitiveTraceIds = new Set(spans.filter((span) => (span as InternalSpan)[SENSITIVE_TRACE_ID] === true).map((span) => span.traceId));
  const outputSpans = redact ? spans.map(redactSpan) : spans;
  const outputTraces = redact ? traces.map((trace) => ({
    ...trace,
    id: redactIdentifier(trace.id, "trace", sensitiveTraceIds.has(trace.id)),
    rootIds: trace.rootIds.map((id) => redactIdentifier(id, "span")),
    spanIds: trace.spanIds.map((id) => redactIdentifier(id, "span")),
    criticalPath: trace.criticalPath.map((id) => redactIdentifier(id, "span")),
  })) : traces;
  const outputUsage = redact ? usageResult.rows.map((row) => ({ ...row, name: redactString(row.name) })) : usageResult.rows;
  const outputLoops = redact ? loopResult.loops.map((loop) => ({
    ...loop,
    traceId: redactIdentifier(loop.traceId, "trace", sensitiveTraceIds.has(loop.traceId)),
    signature: redactString(loop.signature),
    spanIds: loop.spanIds.map((id) => redactIdentifier(id, "span")),
  })) : loopResult.loops;
  const outputRecoveryLedger = redact ? recoveryResult.ledger.map((entry) => ({
    ...entry,
    traceId: redactIdentifier(entry.traceId, "trace", sensitiveTraceIds.has(entry.traceId)),
    parentSpanId: redactIdentifier(entry.parentSpanId, "span"),
    operationSignature: redactString(entry.operationSignature),
    failedAttempts: entry.failedAttempts.map((attempt) => ({
      ...attempt,
      spanId: redactIdentifier(attempt.spanId, "span"),
    })),
    recoveredBy: {
      ...entry.recoveredBy,
      spanId: redactIdentifier(entry.recoveredBy.spanId, "span"),
    },
  })) : recoveryResult.ledger;
  const report: AnalysisReport = {
    schemaVersion: "1.1",
    title: redact ? redactString(options.title ?? "SpanGarden agent trace report") : options.title ?? "SpanGarden agent trace report",
    generatedAt: reproducibleTimestamp(spans),
    source: redact ? redactString(options.source ?? "input") : options.source ?? "input",
    redacted: redact,
    summary: {
      traces: traces.length,
      spans: spans.length,
      errors: spans.filter((span) => span.status === "error").length,
      retries: loopResult.retries,
      recoveredRetries: recoveryResult.ledger.reduce((total, entry) => total + entry.failedAttempts.length, 0),
      loops: loopResult.loops.length,
      totalDurationMs: round(traces.reduce((sum, trace) => sum + trace.durationMs, 0)),
      p50SpanMs: quantile(spans.map((span) => span.durationMs), 0.5),
      p95SpanMs: quantile(spans.map((span) => span.durationMs), 0.95),
      inputTokens: sumSafeIntegers(spans.map((span) => span.inputTokens), "Total input token count"),
      outputTokens: sumSafeIntegers(spans.map((span) => span.outputTokens), "Total output token count"),
    },
    ...(usageResult.cost === undefined ? {} : { cost: usageResult.cost }),
    traces: outputTraces,
    spans: outputSpans,
    usage: outputUsage,
    recoveryLedger: outputRecoveryLedger,
    loops: outputLoops,
    warnings,
  };
  return report;
}
