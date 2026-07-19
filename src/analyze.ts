import { pricingRate } from "./pricing.js";
import { redactSpan } from "./redact.js";
import type {
  AnalysisReport,
  CostSummary,
  LoopFinding,
  NormalizedSpan,
  PricingFile,
  TraceSummary,
  UsageRow,
} from "./types.js";

export interface AnalyzeOptions {
  title?: string;
  source?: string;
  redact?: boolean;
  pricing?: PricingFile;
}

function compareSpans(a: NormalizedSpan, b: NormalizedSpan): number {
  return a.traceId.localeCompare(b.traceId) || a.startMs - b.startMs || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

function round(value: number, places = 3): number {
  const multiplier = 10 ** places;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

function quantile(values: number[], value: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(value * sorted.length) - 1);
  return round(sorted[index] ?? 0);
}

function signature(span: NormalizedSpan): string {
  return `${span.kind}:${span.tool ?? span.model ?? span.name}`.toLowerCase();
}

interface PathResult {
  ids: string[];
  duration: number;
}

function bestPath(rootId: string, byId: Map<string, NormalizedSpan>, children: Map<string, string[]>, visiting = new Set<string>()): PathResult {
  const span = byId.get(rootId);
  if (span === undefined || visiting.has(rootId)) return { ids: [], duration: 0 };
  const nextVisiting = new Set(visiting).add(rootId);
  let best: PathResult = { ids: [], duration: 0 };
  for (const child of children.get(rootId) ?? []) {
    const candidate = bestPath(child, byId, children, nextVisiting);
    if (candidate.duration > best.duration || (candidate.duration === best.duration && candidate.ids.join("\0").localeCompare(best.ids.join("\0")) < 0)) best = candidate;
  }
  return { ids: [rootId, ...best.ids], duration: round(span.durationMs + best.duration) };
}

function reachable(root: string, children: Map<string, string[]>, visited: Set<string>): void {
  if (visited.has(root)) return;
  visited.add(root);
  for (const child of children.get(root) ?? []) reachable(child, children, visited);
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
    if (candidate.duration > critical.duration || (candidate.duration === critical.duration && candidate.ids.join("\0").localeCompare(critical.ids.join("\0")) < 0)) critical = candidate;
  }
  const start = Math.min(...spans.map((span) => span.startMs));
  const end = Math.max(...spans.map((span) => span.endMs));
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

function findLoops(spans: NormalizedSpan[]): { loops: LoopFinding[]; retries: number } {
  const byTrace = new Map<string, NormalizedSpan[]>();
  for (const span of spans) (byTrace.get(span.traceId) ?? byTrace.set(span.traceId, []).get(span.traceId) as NormalizedSpan[]).push(span);
  const findings: LoopFinding[] = [];
  let retries = 0;
  for (const [traceId, traceSpans] of [...byTrace.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const groups = new Map<string, NormalizedSpan[]>();
    for (const span of traceSpans) {
      const key = `${span.parentId ?? "<root>"}\0${signature(span)}`;
      const group = groups.get(key) ?? [];
      group.push(span);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      group.sort(compareSpans);
      retries += Math.max(0, group.length - 1);
      if (group.length >= 3) findings.push({ traceId, signature: signature(group[0] as NormalizedSpan), spanIds: group.map((span) => span.id), reason: "repeated siblings" });
    }

    const byId = new Map(traceSpans.map((span) => [span.id, span]));
    for (const span of traceSpans) {
      const seen = new Map<string, string>();
      const chain: string[] = [];
      let current: NormalizedSpan | undefined = span;
      const visitedIds = new Set<string>();
      while (current !== undefined && !visitedIds.has(current.id)) {
        visitedIds.add(current.id);
        const sig = signature(current);
        const earlier = seen.get(sig);
        chain.push(current.id);
        if (earlier !== undefined) {
          const start = chain.indexOf(earlier);
          findings.push({ traceId, signature: sig, spanIds: chain.slice(Math.max(0, start)), reason: "recursive path" });
          break;
        }
        seen.set(sig, current.id);
        current = current.parentId === undefined ? undefined : byId.get(current.parentId);
      }
    }
  }
  const unique = new Map<string, LoopFinding>();
  for (const finding of findings) unique.set(`${finding.traceId}\0${finding.reason}\0${finding.signature}\0${finding.spanIds.join(",")}`, finding);
  return { loops: [...unique.values()].sort((a, b) => a.traceId.localeCompare(b.traceId) || a.signature.localeCompare(b.signature) || a.spanIds.join().localeCompare(b.spanIds.join())), retries };
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
    row.inputTokens += span.inputTokens;
    row.outputTokens += span.outputTokens;
    rows.set(key, row);
  }
  let estimatedUsd = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  const result = [...rows.values()].sort((a, b) => a.type.localeCompare(b.type) || b.calls - a.calls || a.name.localeCompare(b.name));
  if (pricing !== undefined) {
    for (const row of result) {
      if (row.type !== "model") continue;
      const rate = pricingRate(pricing, row.name);
      const tokens = row.inputTokens + row.outputTokens;
      if (rate === undefined) {
        unpricedTokens += tokens;
        continue;
      }
      const rowCost = row.inputTokens * rate.inputPerMillion / 1_000_000 + row.outputTokens * rate.outputPerMillion / 1_000_000;
      row.estimatedCostUsd = round(rowCost, 8);
      estimatedUsd += rowCost;
      pricedTokens += tokens;
    }
    return {
      rows: result,
      cost: { currency: "USD", estimatedUsd: round(estimatedUsd, 8), pricedTokens, unpricedTokens, source: "local pricing file" },
    };
  }
  return { rows: result };
}

function reproducibleTimestamp(spans: NormalizedSpan[]): string {
  const latest = Math.max(...spans.map((span) => span.endMs));
  return latest >= 946_684_800_000 && latest <= 8_640_000_000_000_000 ? new Date(latest).toISOString() : "1970-01-01T00:00:00.000Z";
}

export function analyzeSpans(inputSpans: NormalizedSpan[], options: AnalyzeOptions = {}): AnalysisReport {
  if (inputSpans.length === 0) throw new Error("Cannot analyze an empty span list");
  const spans = [...inputSpans].sort(compareSpans);
  const traceGroups = new Map<string, NormalizedSpan[]>();
  for (const span of spans) {
    const bucket = traceGroups.get(span.traceId) ?? [];
    bucket.push(span);
    traceGroups.set(span.traceId, bucket);
  }
  const traces = [...traceGroups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, traceSpans]) => buildTrace(id, traceSpans));
  const loopResult = findLoops(spans);
  const usageResult = usageRows(spans, options.pricing);
  const knownIds = new Set(spans.map((span) => span.id));
  const orphanCount = spans.filter((span) => span.parentId !== undefined && !knownIds.has(span.parentId)).length;
  const zeroTiming = spans.filter((span) => span.startMs === 0 && span.durationMs === 0).length;
  const warnings: string[] = [];
  if (orphanCount > 0) warnings.push(`${orphanCount} span(s) reference a missing parent and were treated as roots.`);
  if (zeroTiming > 0) warnings.push(`${zeroTiming} span(s) have no usable timing information.`);
  if (usageResult.cost !== undefined && usageResult.cost.unpricedTokens > 0) warnings.push(`${usageResult.cost.unpricedTokens} model token(s) remain unpriced because no local rate matched.`);
  const redact = options.redact ?? true;
  const outputSpans = redact ? spans.map(redactSpan) : spans;
  const report: AnalysisReport = {
    schemaVersion: "1.0",
    title: options.title ?? "SpanGarden agent trace report",
    generatedAt: reproducibleTimestamp(spans),
    source: options.source ?? "input",
    redacted: redact,
    summary: {
      traces: traces.length,
      spans: spans.length,
      errors: spans.filter((span) => span.status === "error").length,
      retries: loopResult.retries,
      loops: loopResult.loops.length,
      totalDurationMs: round(traces.reduce((sum, trace) => sum + trace.durationMs, 0)),
      p50SpanMs: quantile(spans.map((span) => span.durationMs), 0.5),
      p95SpanMs: quantile(spans.map((span) => span.durationMs), 0.95),
      inputTokens: spans.reduce((sum, span) => sum + span.inputTokens, 0),
      outputTokens: spans.reduce((sum, span) => sum + span.outputTokens, 0),
    },
    ...(usageResult.cost === undefined ? {} : { cost: usageResult.cost }),
    traces,
    spans: outputSpans,
    usage: usageResult.rows,
    loops: loopResult.loops,
    warnings,
  };
  return report;
}
