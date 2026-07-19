import type { JsonObject, JsonValue, NormalizedSpan, SpanKind, SpanStatus } from "./types.js";

interface Candidate {
  value: Record<string, unknown>;
  inherited: JsonObject;
  parentId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (!isRecord(value)) return undefined;
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue", "value"]) {
    const inner = value[key];
    if (inner === null || typeof inner === "string" || typeof inner === "number" || typeof inner === "boolean") return inner;
  }
  return undefined;
}

function toJson(value: unknown, depth = 0): JsonValue {
  if (depth > 8) return "[TRUNCATED]";
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => toJson(item, depth + 1));
  if (isRecord(value)) {
    const direct = scalar(value);
    if (direct !== undefined) return direct;
    if (Array.isArray(value.arrayValue)) return value.arrayValue.slice(0, 1_000).map((item) => toJson(item, depth + 1));
    if (isRecord(value.arrayValue) && Array.isArray(value.arrayValue.values)) {
      return value.arrayValue.values.slice(0, 1_000).map((item) => toJson(item, depth + 1));
    }
    const result: JsonObject = {};
    for (const key of Object.keys(value).sort().slice(0, 1_000)) result[key] = toJson(value[key], depth + 1);
    return result;
  }
  return String(value);
}

function attributes(value: unknown): JsonObject {
  if (Array.isArray(value)) {
    const output: JsonObject = {};
    for (const item of value) {
      if (!isRecord(item) || typeof item.key !== "string") continue;
      output[item.key] = toJson(item.value);
    }
    return output;
  }
  return isRecord(value) ? (toJson(value) as JsonObject) : {};
}

function first(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  const parsed = scalar(value);
  if (typeof parsed === "string") return parsed;
  if (typeof parsed === "number" || typeof parsed === "boolean") return String(parsed);
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = scalar(value);
  const numeric = typeof parsed === "number" ? parsed : typeof parsed === "string" && parsed.trim() !== "" ? Number(parsed) : Number.NaN;
  return Number.isFinite(numeric) ? numeric : undefined;
}

function attr(record: JsonObject, ...keys: string[]): JsonValue | undefined {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

function parseTime(value: unknown, nanoseconds: boolean): number | undefined {
  if (typeof value === "string") {
    if (/^\d+$/u.test(value)) {
      try {
        const raw = BigInt(value);
        return nanoseconds ? Number(raw / 1_000_000n) : Number(raw);
      } catch {
        return undefined;
      }
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return nanoseconds ? value / 1_000_000 : value;
  return undefined;
}

function looksLikeSpan(record: Record<string, unknown>): boolean {
  const hasId = first(record, ["spanId", "span_id", "id", "run_id"]) !== undefined;
  const hasName = first(record, ["name", "operation", "event", "type"]) !== undefined;
  const hasTiming = first(record, ["startTimeUnixNano", "startTime", "start_time", "timestamp", "durationMs", "duration_ms"]) !== undefined;
  return hasId || (hasName && hasTiming);
}

function collect(value: unknown, output: Candidate[], inherited: JsonObject = {}, parentId?: string): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, output, inherited, parentId);
    return;
  }
  if (!isRecord(value)) return;

  const resource = isRecord(value.resource) ? attributes(value.resource.attributes ?? value.resource) : {};
  const merged = { ...inherited, ...resource };
  let ownParent = parentId;
  if (looksLikeSpan(value)) {
    output.push({ value, inherited: merged, ...(parentId === undefined ? {} : { parentId }) });
    ownParent = stringValue(first(value, ["spanId", "span_id", "id", "run_id"])) ?? parentId;
  }

  const containerKeys = ["resourceSpans", "scopeSpans", "instrumentationLibrarySpans", "spans", "traces", "runs", "events", "children", "steps"];
  for (const key of containerKeys) {
    if (value[key] !== undefined) collect(value[key], output, merged, key === "children" || key === "steps" ? ownParent : parentId);
  }
}

function classify(name: string, attrs: JsonObject, record: Record<string, unknown>): SpanKind {
  const explicit = (stringValue(first(record, ["kind", "type"])) ?? stringValue(attr(attrs, "gen_ai.operation.name", "openinference.span.kind")) ?? "").toLowerCase();
  const haystack = `${explicit} ${name}`.toLowerCase();
  if (/tool|function/u.test(haystack) || attr(attrs, "gen_ai.tool.name", "tool.name") !== undefined) return "tool";
  if (/chat|completion|llm|model|embedding/u.test(haystack) || attr(attrs, "gen_ai.request.model", "gen_ai.response.model", "llm.model_name") !== undefined) return "model";
  if (/retriev|vector|search/u.test(haystack)) return "retrieval";
  if (/agent|chain|workflow|run/u.test(haystack)) return "agent";
  return "other";
}

function statusOf(record: Record<string, unknown>, attrs: JsonObject): SpanStatus {
  const rawStatus = record.status;
  const statusCode = isRecord(rawStatus) ? first(rawStatus, ["code", "statusCode"]) : rawStatus;
  const text = `${stringValue(statusCode) ?? ""} ${stringValue(first(record, ["error", "exception"])) ?? ""} ${stringValue(attr(attrs, "error.type")) ?? ""}`.toLowerCase();
  if (/error|fail|exception|\b2\b/u.test(text)) return "error";
  if (/ok|success|\b1\b/u.test(text)) return "ok";
  return "unset";
}

function metric(attrs: JsonObject, record: Record<string, unknown>, keys: string[]): number {
  const raw = first(record, keys) ?? attr(attrs, ...keys);
  const value = numberValue(raw);
  return value !== undefined && value >= 0 ? Math.round(value) : 0;
}

function normalize(candidate: Candidate, index: number, usedIds: Set<string>): NormalizedSpan {
  const record = candidate.value;
  const ownAttrs = attributes(record.attributes ?? record.tags ?? record.metadata);
  const attrs: JsonObject = { ...candidate.inherited, ...ownAttrs };
  const rawId = stringValue(first(record, ["spanId", "span_id", "id", "run_id"])) ?? `span-${index + 1}`;
  let id = rawId;
  let suffix = 2;
  while (usedIds.has(id)) id = `${rawId}-${suffix++}`;
  usedIds.add(id);
  const traceId = stringValue(first(record, ["traceId", "trace_id", "session_id"])) ?? stringValue(attr(attrs, "trace.id")) ?? "trace-1";
  const parentId = stringValue(first(record, ["parentSpanId", "parent_span_id", "parentId", "parent_id"])) ?? candidate.parentId;
  const name = stringValue(first(record, ["name", "operation", "event", "type"])) ?? "unnamed span";
  const startNano = first(record, ["startTimeUnixNano", "start_time_unix_nano"]);
  const endNano = first(record, ["endTimeUnixNano", "end_time_unix_nano"]);
  const start = parseTime(startNano ?? first(record, ["startTime", "start_time", "timestamp", "time"]), startNano !== undefined) ?? 0;
  const explicitDuration = numberValue(first(record, ["durationMs", "duration_ms", "latency_ms"]));
  const endParsed = parseTime(endNano ?? first(record, ["endTime", "end_time"]), endNano !== undefined);
  const duration = Math.max(0, explicitDuration ?? (endParsed === undefined ? 0 : endParsed - start));
  const end = endParsed ?? start + duration;
  const model = stringValue(first(record, ["model", "model_name"])) ?? stringValue(attr(attrs, "gen_ai.response.model", "gen_ai.request.model", "llm.model_name"));
  const tool = stringValue(first(record, ["tool", "tool_name", "function_name"])) ?? stringValue(attr(attrs, "gen_ai.tool.name", "tool.name"));
  return {
    id,
    traceId,
    ...(parentId === undefined || parentId === "" ? {} : { parentId }),
    name,
    kind: classify(name, attrs, record),
    startMs: start,
    endMs: Math.max(start, end),
    durationMs: duration,
    status: statusOf(record, attrs),
    ...(model === undefined ? {} : { model }),
    ...(tool === undefined ? {} : { tool }),
    inputTokens: metric(attrs, record, ["gen_ai.usage.input_tokens", "llm.token_count.prompt", "input_tokens", "prompt_tokens"]),
    outputTokens: metric(attrs, record, ["gen_ai.usage.output_tokens", "llm.token_count.completion", "output_tokens", "completion_tokens"]),
    attributes: attrs,
  };
}

export function adaptSpans(input: unknown): NormalizedSpan[] {
  const candidates: Candidate[] = [];
  collect(input, candidates);
  if (candidates.length === 0) throw new Error("No trace spans found. Expected generic spans or OpenTelemetry resourceSpans.");
  const usedIds = new Set<string>();
  return candidates.map((candidate, index) => normalize(candidate, index, usedIds));
}
