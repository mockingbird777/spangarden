export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export type SpanKind = "agent" | "model" | "tool" | "retrieval" | "other";
export type SpanStatus = "ok" | "error" | "unset";

export interface NormalizedSpan {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  kind: SpanKind;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: SpanStatus;
  model?: string;
  tool?: string;
  inputTokens: number;
  outputTokens: number;
  attributes: JsonObject;
}

export interface TraceSummary {
  id: string;
  rootIds: string[];
  spanIds: string[];
  startMs: number;
  endMs: number;
  durationMs: number;
  criticalPath: string[];
  criticalPathMs: number;
}

export interface UsageRow {
  type: "model" | "tool";
  name: string;
  calls: number;
  errors: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd?: number;
}

export interface LoopFinding {
  traceId: string;
  signature: string;
  spanIds: string[];
  reason: "recursive path" | "repeated siblings";
}

export interface PricingRate {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface PricingFile {
  currency?: "USD";
  models: Record<string, PricingRate>;
}

export interface CostSummary {
  currency: "USD";
  estimatedUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
  source: "local pricing file";
}

export interface ReportSummary {
  traces: number;
  spans: number;
  errors: number;
  retries: number;
  loops: number;
  totalDurationMs: number;
  p50SpanMs: number;
  p95SpanMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AnalysisReport {
  schemaVersion: "1.0";
  title: string;
  generatedAt: string;
  source: string;
  redacted: boolean;
  summary: ReportSummary;
  cost?: CostSummary;
  traces: TraceSummary[];
  spans: NormalizedSpan[];
  usage: UsageRow[];
  loops: LoopFinding[];
  warnings: string[];
}

export type OutputFormat = "terminal" | "json" | "markdown" | "html";
