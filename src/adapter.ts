import { SENSITIVE_TRACE_ID } from "./internal.js";
import type { JsonObject, JsonValue, NormalizedSpan, SpanKind, SpanStatus } from "./types.js";

interface Candidate {
  value: Record<string, unknown>;
  inherited: JsonObject;
  rawId: string;
  traceId: string;
  traceIdSensitive: boolean;
  parentId?: string;
  parentIndex?: number;
}

interface ParentContext {
  index: number;
  rawId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function setJsonProperty(target: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
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
    if (isRecord(value.kvlistValue) && Array.isArray(value.kvlistValue.values)) {
      const output: JsonObject = {};
      for (const item of value.kvlistValue.values.slice(0, 1_000)) {
        if (!isRecord(item) || typeof item.key !== "string") continue;
        setJsonProperty(output, item.key, toJson(item.value, depth + 1));
      }
      return output;
    }
    const result: JsonObject = {};
    for (const key of Object.keys(value).sort().slice(0, 1_000)) setJsonProperty(result, key, toJson(value[key], depth + 1));
    return result;
  }
  return String(value);
}

function attributes(value: unknown): JsonObject {
  if (Array.isArray(value)) {
    const output: JsonObject = {};
    for (const item of value) {
      if (!isRecord(item) || typeof item.key !== "string") continue;
      setJsonProperty(output, item.key, toJson(item.value));
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
    if (/^-?\d+$/u.test(value)) {
      try {
        const raw = BigInt(value);
        const parsed = nanoseconds
          ? Number(raw / 1_000_000n) + Number(raw % 1_000_000n) / 1_000_000
          : Number(raw);
        return Number.isFinite(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = nanoseconds ? value / 1_000_000 : value;
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function looksLikeSpan(record: Record<string, unknown>): boolean {
  const hasId = first(record, ["spanId", "span_id", "id", "run_id"]) !== undefined;
  const hasName = first(record, ["name", "operation", "event", "type", "run_type"]) !== undefined;
  const hasTiming = first(record, ["startTimeUnixNano", "start_time_unix_nano", "startTime", "start_time", "started_at", "timestamp", "durationMs", "duration_ms"]) !== undefined;
  return (hasId && (hasName || hasTiming)) || (hasName && hasTiming);
}

function collect(input: unknown, output: Candidate[]): void {
  interface Frame {
    value: unknown;
    inherited: JsonObject;
    traceId?: string;
    traceIdSensitive?: boolean;
    parent?: ParentContext;
  }
  const stack: Frame[] = [{ value: input, inherited: {} }];
  const seen = new WeakSet<object>();
  const containerKeys = ["resourceSpans", "scopeSpans", "instrumentationLibrarySpans", "spans", "traces", "runs", "events", "children", "steps"];

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if ((typeof frame.value === "object" && frame.value !== null)) {
      if (seen.has(frame.value)) continue;
      seen.add(frame.value);
    }
    if (Array.isArray(frame.value)) {
      for (let index = frame.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: frame.value[index],
          inherited: frame.inherited,
          ...(frame.traceId === undefined ? {} : { traceId: frame.traceId }),
          ...(frame.traceIdSensitive === undefined ? {} : { traceIdSensitive: frame.traceIdSensitive }),
          ...(frame.parent === undefined ? {} : { parent: frame.parent }),
        });
      }
      continue;
    }
    if (!isRecord(frame.value)) continue;

    const resource = isRecord(frame.value.resource) ? attributes(frame.value.resource.attributes ?? frame.value.resource) : {};
    const merged = { ...frame.inherited, ...resource };
    const explicitTraceId = stringValue(first(frame.value, ["traceId", "trace_id"]));
    const sessionTraceId = explicitTraceId === undefined ? stringValue(first(frame.value, ["session_id"])) : undefined;
    const contextTraceId = explicitTraceId ?? sessionTraceId ?? frame.traceId;
    const contextTraceIdSensitive = explicitTraceId !== undefined ? false : sessionTraceId !== undefined ? true : frame.traceIdSensitive ?? false;
    let ownParent = frame.parent;
    let candidateTraceId = contextTraceId;
    let candidateTraceIdSensitive = contextTraceIdSensitive;
    if (looksLikeSpan(frame.value)) {
      const rawId = stringValue(first(frame.value, ["spanId", "span_id", "id", "run_id"])) ?? `span-${output.length + 1}`;
      const ownAttrs = attributes(frame.value.attributes ?? frame.value.tags ?? frame.value.metadata);
      candidateTraceId = contextTraceId ?? stringValue(attr({ ...merged, ...ownAttrs }, "trace.id")) ?? "trace-1";
      candidateTraceIdSensitive = contextTraceId === undefined ? false : contextTraceIdSensitive;
      const candidate: Candidate = {
        value: frame.value,
        inherited: merged,
        rawId,
        traceId: candidateTraceId,
        traceIdSensitive: candidateTraceIdSensitive,
        ...(frame.parent === undefined ? {} : { parentId: frame.parent.rawId, parentIndex: frame.parent.index }),
      };
      output.push(candidate);
      ownParent = { index: output.length - 1, rawId };
    }

    for (let keyIndex = containerKeys.length - 1; keyIndex >= 0; keyIndex -= 1) {
      const key = containerKeys[keyIndex] as string;
      if (frame.value[key] === undefined) continue;
      const nested = key === "children" || key === "steps" ? ownParent : frame.parent;
      stack.push({
        value: frame.value[key],
        inherited: merged,
        ...(candidateTraceId === undefined ? {} : { traceId: candidateTraceId }),
        ...(candidateTraceId === undefined ? {} : { traceIdSensitive: candidateTraceIdSensitive }),
        ...(nested === undefined ? {} : { parent: nested }),
      });
    }
  }
}

function classify(name: string, attrs: JsonObject, record: Record<string, unknown>): SpanKind {
  const explicit = (stringValue(first(record, ["kind", "type", "run_type"])) ?? stringValue(attr(attrs, "gen_ai.operation.name", "openinference.span.kind")) ?? "").toLowerCase();
  if (/tool|function/u.test(explicit)) return "tool";
  if (/chat|completion|llm|model|embedding/u.test(explicit)) return "model";
  if (/retriev|vector|search/u.test(explicit)) return "retrieval";
  if (/agent|chain|workflow|run/u.test(explicit)) return "agent";
  if (attr(attrs, "gen_ai.tool.name", "tool.name") !== undefined) return "tool";
  if (attr(attrs, "gen_ai.request.model", "gen_ai.response.model", "llm.model_name") !== undefined) return "model";
  const normalizedName = name.toLowerCase();
  if (/tool|function/u.test(normalizedName)) return "tool";
  if (/chat|completion|llm|model|embedding/u.test(normalizedName)) return "model";
  if (/retriev|vector|search/u.test(normalizedName)) return "retrieval";
  if (/agent|chain|workflow|run/u.test(normalizedName)) return "agent";
  return "other";
}

function statusOf(record: Record<string, unknown>, attrs: JsonObject): SpanStatus {
  const rawStatus = record.status;
  const statusCode = isRecord(rawStatus) ? first(rawStatus, ["code", "statusCode"]) : rawStatus;
  const rawError = first(record, ["error", "exception"]);
  const text = `${stringValue(statusCode) ?? ""} ${stringValue(rawError) ?? ""} ${stringValue(attr(attrs, "error.type", "exception.type")) ?? ""}`.toLowerCase();
  if ((isRecord(rawError) || Array.isArray(rawError)) && rawError !== null) return "error";
  if (/error|fail|exception|\b2\b/u.test(text)) return "error";
  if (/ok|success|\b1\b/u.test(text)) return "ok";
  return "unset";
}

function metric(attrs: JsonObject, record: Record<string, unknown>, keys: string[]): number {
  let raw = first(record, keys) ?? attr(attrs, ...keys);
  if (raw === undefined) {
    for (const containerName of ["usage", "usage_metadata", "token_usage"]) {
      const container = record[containerName] ?? attrs[containerName];
      if (!isRecord(container)) continue;
      raw = first(container, keys);
      if (raw !== undefined) break;
    }
  }
  const value = numberValue(raw);
  return value !== undefined && value >= 0 ? Math.round(value) : 0;
}

function normalize(candidate: Candidate, usedIds: Set<string>): NormalizedSpan {
  const record = candidate.value;
  const ownAttrs = attributes(record.attributes ?? record.tags ?? record.metadata);
  const attrs: JsonObject = { ...candidate.inherited, ...ownAttrs };
  const rawId = candidate.rawId;
  let id = rawId;
  let suffix = 2;
  while (usedIds.has(id)) id = `${rawId}-${suffix++}`;
  usedIds.add(id);
  const traceId = candidate.traceId;
  const parentId = stringValue(first(record, ["parentSpanId", "parent_span_id", "parentId", "parent_id", "parent_run_id"])) ?? candidate.parentId;
  const name = stringValue(first(record, ["name", "operation", "event", "type", "run_type"])) ?? "unnamed span";
  const startNano = first(record, ["startTimeUnixNano", "start_time_unix_nano"]);
  const endNano = first(record, ["endTimeUnixNano", "end_time_unix_nano"]);
  const start = parseTime(startNano ?? first(record, ["startTime", "start_time", "started_at", "timestamp", "time"]), startNano !== undefined) ?? 0;
  const explicitDuration = numberValue(first(record, ["durationMs", "duration_ms", "latency_ms"]));
  const endParsed = parseTime(endNano ?? first(record, ["endTime", "end_time", "ended_at"]), endNano !== undefined);
  const duration = Math.max(0, explicitDuration ?? (endParsed === undefined ? 0 : endParsed - start));
  const end = endParsed ?? start + duration;
  const model = stringValue(first(record, ["model", "model_name"])) ?? stringValue(attr(attrs, "gen_ai.response.model", "gen_ai.request.model", "llm.model_name"));
  const tool = stringValue(first(record, ["tool", "tool_name", "function_name"])) ?? stringValue(attr(attrs, "gen_ai.tool.name", "tool.name"));
  const normalized: NormalizedSpan = {
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
    inputTokens: metric(attrs, record, ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens", "llm.token_count.prompt", "input_tokens", "prompt_tokens"]),
    outputTokens: metric(attrs, record, ["gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens", "llm.token_count.completion", "output_tokens", "completion_tokens"]),
    attributes: attrs,
  };
  return normalized;
}

export function adaptSpans(input: unknown): NormalizedSpan[] {
  const candidates: Candidate[] = [];
  collect(input, candidates);
  if (candidates.length === 0) throw new Error("No trace spans found. Expected generic spans or OpenTelemetry resourceSpans.");
  const usedIds = new Set<string>();
  const spans = candidates.map((candidate) => normalize(candidate, usedIds));
  const canonicalIds = new Map<string, Map<string, string>>();
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index] as NormalizedSpan;
    const candidate = candidates[index] as Candidate;
    const traceIds = canonicalIds.get(span.traceId) ?? new Map<string, string>();
    if (!traceIds.has(candidate.rawId)) traceIds.set(candidate.rawId, span.id);
    canonicalIds.set(span.traceId, traceIds);
  }
  return spans.map((span, index) => {
    const candidate = candidates[index] as Candidate;
    const explicitParent = stringValue(first(candidate.value, ["parentSpanId", "parent_span_id", "parentId", "parent_id", "parent_run_id"]));
    const mappedParent = explicitParent === undefined
      ? candidate.parentIndex === undefined ? undefined : spans[candidate.parentIndex]?.id
      : canonicalIds.get(span.traceId)?.get(explicitParent) ?? explicitParent;
    let result: NormalizedSpan;
    if (mappedParent === undefined || mappedParent === "") {
      const { parentId: _parentId, ...withoutParent } = span;
      result = withoutParent;
    } else {
      result = { ...span, parentId: mappedParent };
    }
    if (candidate.traceIdSensitive) Object.defineProperty(result, SENSITIVE_TRACE_ID, { value: true });
    return result;
  });
}
