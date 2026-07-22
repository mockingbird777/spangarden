import assert from "node:assert/strict";
import test from "node:test";
import { adaptSpans } from "../src/adapter.js";
import { analyzeSpans } from "../src/analyze.js";
import { span } from "./helpers.js";

test("builds roots and chooses a deterministic duration-weighted critical path", () => {
  const report = analyzeSpans([
    span("root", { startMs: 1000, endMs: 1100, durationMs: 100 }),
    span("a", { parentId: "root", startMs: 1010, endMs: 1030, durationMs: 20 }),
    span("b", { parentId: "root", startMs: 1020, endMs: 1090, durationMs: 70 }),
    span("leaf", { parentId: "b", startMs: 1040, endMs: 1080, durationMs: 40 }),
  ]);
  assert.deepEqual(report.traces[0]?.rootIds, ["root"]);
  assert.deepEqual(report.traces[0]?.criticalPath, ["root", "b", "leaf"]);
  assert.equal(report.traces[0]?.criticalPathMs, 210);
  assert.equal(report.summary.totalDurationMs, 100);
});

test("counts repeated siblings as retries and surfaces a loop at three calls", () => {
  const report = analyzeSpans([
    span("root"),
    span("try-1", { parentId: "root", kind: "tool", tool: "weather", status: "error", startMs: 1 }),
    span("try-2", { parentId: "root", kind: "tool", tool: "weather", status: "error", startMs: 2 }),
    span("try-3", { parentId: "root", kind: "tool", tool: "weather", startMs: 3 }),
  ]);
  assert.equal(report.summary.retries, 2);
  assert.equal(report.summary.loops, 1);
  assert.equal(report.loops[0]?.reason, "repeated siblings");
  assert.deepEqual(report.loops[0]?.spanIds, ["try-1", "try-2", "try-3"]);
});

test("builds a verifiable Recovery Ledger for serial failed attempts followed by a non-failure", () => {
  const spans = [
    span("root", { startMs: 1, endMs: 120, durationMs: 119 }),
    span("failed-1", {
      parentId: "root", kind: "model", model: "alpha", name: "chat", status: "error",
      startMs: 10, endMs: 20, durationMs: 10, inputTokens: 100, outputTokens: 20,
      attributes: { "gen_ai.operation.name": "chat" },
    }),
    span("failed-2", {
      parentId: "root", kind: "model", model: "ALPHA", name: "chat", status: "error",
      startMs: 30, endMs: 50, durationMs: 20, inputTokens: 200, outputTokens: 30,
      attributes: { "gen_ai.operation.name": "chat" },
    }),
    span("recovered", {
      parentId: "root", kind: "model", model: "alpha", name: "chat", status: "ok",
      startMs: 70, endMs: 100, durationMs: 30, inputTokens: 300, outputTokens: 40,
      attributes: { "gen_ai.operation.name": "chat" },
    }),
  ];
  const before = structuredClone(spans);
  for (const item of spans) {
    Object.freeze(item.attributes);
    Object.freeze(item);
  }
  Object.freeze(spans);

  const report = analyzeSpans(spans, { pricing: { models: { alpha: { inputPerMillion: 2, outputPerMillion: 8 } } } });
  assert.deepEqual(spans, before, "analysis must not mutate caller-owned input");
  assert.equal(report.schemaVersion, "1.1");
  assert.equal(report.summary.recoveredRetries, 2);
  assert.equal(report.recoveryLedger.length, 1);
  const recovery = report.recoveryLedger[0];
  assert.equal(recovery?.operationSignature, "model:alpha:chat");
  assert.equal(recovery?.traceId, "trace-a");
  assert.equal(recovery?.parentSpanId, "root");
  assert.deepEqual(recovery?.failedAttempts.map((attempt) => attempt.spanId), ["failed-1", "failed-2"]);
  assert.equal(recovery?.recoveredBy.spanId, "recovered");
  assert.equal(recovery?.recoveredBy.status, "ok");
  assert.equal(recovery?.failedDurationMs, 30);
  assert.equal(recovery?.retryDelayMs, 20);
  assert.equal(recovery?.recoveryLatencyMs, 80);
  assert.equal(recovery?.failedInputTokens, 300);
  assert.equal(recovery?.failedOutputTokens, 50);
  assert.equal(recovery?.estimatedFailedCostUsd, 0.001);
  assert.equal(recovery?.failedAttempts[0]?.estimatedCostUsd, 0.00036);
  assert.equal(recovery?.recoveredBy.estimatedCostUsd, 0.00092);
});

test("Recovery Ledger excludes parallel siblings, name-only matches, and cross-context matches", () => {
  const report = analyzeSpans([
    span("root", { startMs: 1, endMs: 100, durationMs: 99 }),
    span("parallel-error", { parentId: "root", kind: "tool", tool: "search", status: "error", startMs: 10, endMs: 50, durationMs: 40 }),
    span("parallel-ok", { parentId: "root", kind: "tool", tool: "search", status: "ok", startMs: 20, endMs: 60, durationMs: 40 }),
    span("simultaneous-error", { parentId: "root", kind: "tool", tool: "clock", status: "error", startMs: 60, endMs: 60, durationMs: 0 }),
    span("simultaneous-ok", { parentId: "root", kind: "tool", tool: "clock", status: "ok", startMs: 60, endMs: 60, durationMs: 0 }),
    span("name-error", { parentId: "root", name: "same-name", status: "error", startMs: 61, endMs: 65, durationMs: 4 }),
    span("name-ok", { parentId: "root", name: "same-name", status: "ok", startMs: 66, endMs: 70, durationMs: 4 }),
    span("parent-a-error", { parentId: "root", kind: "tool", tool: "weather", status: "error", startMs: 71, endMs: 75, durationMs: 4 }),
    span("parent-b-ok", { parentId: "different-root", kind: "tool", tool: "weather", status: "ok", startMs: 76, endMs: 80, durationMs: 4 }),
    span("trace-a-error", { traceId: "trace-a", parentId: "shared-parent", kind: "tool", tool: "maps", status: "error", startMs: 81, endMs: 85, durationMs: 4 }),
    span("trace-b-ok", { traceId: "trace-b", parentId: "shared-parent", kind: "tool", tool: "maps", status: "ok", startMs: 86, endMs: 90, durationMs: 4 }),
  ]);
  assert.equal(report.recoveryLedger.length, 0);
  assert.equal(report.summary.recoveredRetries, 0);
  assert.ok(report.warnings.some((warning) => warning.includes("overlapping or simultaneous sibling spans")));
});

test("Recovery Ledger omits unverifiable timing and unknown token or cost evidence", () => {
  const unknownTiming = analyzeSpans([
    span("root"),
    span("failed", { parentId: "root", kind: "tool", tool: "weather", status: "error", startMs: 0, endMs: 0, durationMs: 0 }),
    span("next", { parentId: "root", kind: "tool", tool: "weather", status: "unset", startMs: 10, endMs: 20, durationMs: 10 }),
  ]);
  assert.equal(unknownTiming.recoveryLedger.length, 0);
  assert.ok(unknownTiming.warnings.some((warning) => warning.includes("without usable timing evidence")));

  const unpriced = analyzeSpans([
    span("root", { startMs: 1 }),
    span("failed", { parentId: "root", kind: "tool", tool: "weather", status: "error", startMs: 10, endMs: 20, durationMs: 10 }),
    span("next", { parentId: "root", kind: "tool", tool: "weather", status: "unset", startMs: 25, endMs: 35, durationMs: 10 }),
  ]);
  const entry = unpriced.recoveryLedger[0];
  assert.equal(entry?.recoveredBy.status, "unset");
  assert.equal(entry?.failedInputTokens, undefined);
  assert.equal(entry?.estimatedFailedCostUsd, undefined);
  assert.equal(entry?.failedAttempts[0]?.estimatedCostUsd, undefined);

  const partialTokens = analyzeSpans([
    span("root", { startMs: 1 }),
    span("failed-with-tokens", { parentId: "root", kind: "model", model: "alpha", name: "chat", status: "error", startMs: 10, endMs: 20, durationMs: 10, inputTokens: 12 }),
    span("failed-without-tokens", { parentId: "root", kind: "model", model: "alpha", name: "chat", status: "error", startMs: 21, endMs: 30, durationMs: 9 }),
    span("next", { parentId: "root", kind: "model", model: "alpha", name: "chat", status: "ok", startMs: 31, endMs: 40, durationMs: 9 }),
  ]);
  assert.equal(partialTokens.recoveryLedger[0]?.failedAttempts[0]?.inputTokens, 12);
  assert.equal(partialTokens.recoveryLedger[0]?.failedAttempts[1]?.inputTokens, undefined);
  assert.equal(partialTokens.recoveryLedger[0]?.failedInputTokens, undefined, "partial token evidence must not be presented as a total");
});

test("detects recurrence along a parent path", () => {
  const report = analyzeSpans([
    span("outer", { kind: "agent", name: "planner" }),
    span("middle", { parentId: "outer", kind: "tool", tool: "search" }),
    span("inner", { parentId: "middle", kind: "agent", name: "planner" }),
  ]);
  assert.ok(report.loops.some((loop) => loop.reason === "recursive path" && loop.signature === "agent:planner"));
});

test("recovers from parent cycles without recursion failure", () => {
  const report = analyzeSpans([
    span("a", { parentId: "b" }),
    span("b", { parentId: "a" }),
  ]);
  assert.equal(report.summary.spans, 2);
  assert.ok((report.traces[0]?.rootIds.length ?? 0) >= 1);
  assert.ok((report.traces[0]?.criticalPath.length ?? 0) >= 1);
});

test("aggregates model/tool usage and prices only matching models", () => {
  const report = analyzeSpans([
    span("m1", { kind: "model", model: "alpha", inputTokens: 1_000_000, outputTokens: 500_000, durationMs: 50 }),
    span("m2", { kind: "model", model: "missing", inputTokens: 5, outputTokens: 5, durationMs: 40 }),
    span("t1", { kind: "tool", tool: "search", status: "error", durationMs: 10 }),
  ], { pricing: { models: { alpha: { inputPerMillion: 2, outputPerMillion: 8 } } } });
  assert.equal(report.cost?.estimatedUsd, 6);
  assert.equal(report.cost?.pricedTokens, 1_500_000);
  assert.equal(report.cost?.unpricedTokens, 10);
  assert.equal(report.usage.find((row) => row.name === "search")?.errors, 1);
  assert.ok(report.warnings.some((warning) => warning.includes("unpriced")));
});

test("uses wildcard pricing and case-insensitive exact rates", () => {
  const report = analyzeSpans([
    span("a", { kind: "model", model: "ALPHA", inputTokens: 1_000_000 }),
    span("b", { kind: "model", model: "other", outputTokens: 1_000_000 }),
  ], { pricing: { models: { alpha: { inputPerMillion: 1, outputPerMillion: 2 }, "*": { inputPerMillion: 3, outputPerMillion: 4 } } } });
  assert.equal(report.cost?.estimatedUsd, 5);
  assert.equal(report.cost?.unpricedTokens, 0);
});

test("redacts by default and can preserve controlled inputs explicitly", () => {
  const sensitive = span("x", { attributes: { authorization: "Bearer abcdefghijklmnop" } });
  assert.equal(analyzeSpans([sensitive]).spans[0]?.attributes.authorization, "[REDACTED]");
  assert.equal(analyzeSpans([sensitive], { redact: false }).spans[0]?.attributes.authorization, "Bearer abcdefghijklmnop");
});

test("produces deterministic reports for identical traces", () => {
  const spans = [span("z", { traceId: "b" }), span("a", { traceId: "a" })];
  const first = analyzeSpans(spans, { title: "Stable" });
  const second = analyzeSpans([...spans].reverse(), { title: "Stable" });
  assert.deepEqual(first, second);
  assert.equal(first.generatedAt, "1970-01-01T00:00:00.000Z");
});

test("sorts and redacts Recovery Ledger evidence deterministically", () => {
  const spans = [
    span("alice@example.test", {
      traceId: "Bearer abcdefghijklmnop", parentId: "parent@example.test", kind: "tool", tool: "sk-abcdefghijklmnop",
      status: "error", startMs: 10, endMs: 20, durationMs: 10,
    }),
    span("safe-next", {
      traceId: "Bearer abcdefghijklmnop", parentId: "parent@example.test", kind: "tool", tool: "sk-abcdefghijklmnop",
      status: "ok", startMs: 25, endMs: 35, durationMs: 10,
    }),
  ];
  const first = analyzeSpans(spans);
  const second = analyzeSpans([...spans].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.recoveryLedger.length, 1);
  assert.ok(!JSON.stringify(first.recoveryLedger).includes("alice@example.test"));
  assert.ok(!JSON.stringify(first.recoveryLedger).includes("abcdefghijklmnop"));
  assert.equal(first.recoveryLedger[0]?.failedAttempts[0]?.spanId, first.spans[0]?.id);
  assert.equal(first.recoveryLedger[0]?.traceId, first.traces[0]?.id);
});

test("warns about missing parent and timing data", () => {
  const report = analyzeSpans([span("orphan", { parentId: "gone", startMs: 0, endMs: 0, durationMs: 0 })]);
  assert.equal(report.traces[0]?.rootIds[0], "orphan");
  assert.equal(report.warnings.length, 2);
});

test("scopes missing-parent checks to a trace", () => {
  const report = analyzeSpans([
    span("parent", { traceId: "trace-a" }),
    span("child", { traceId: "trace-b", parentId: "parent" }),
  ]);
  assert.ok(report.warnings.some((warning) => warning.includes("missing parent")));
  assert.deepEqual(report.traces.find((trace) => trace.id === "trace-b")?.rootIds, ["child"]);
});

test("analyzes a deep parent chain without recursive stack growth", () => {
  const spans = Array.from({ length: 12_000 }, (_, index) => span(`span-${index}`, {
    name: `operation-${index}`,
    ...(index === 0 ? {} : { parentId: `span-${index - 1}` }),
    startMs: index,
    endMs: index + 1,
    durationMs: 1,
  }));
  const report = analyzeSpans(spans);
  assert.equal(report.traces[0]?.criticalPath.length, 12_000);
  assert.equal(report.traces[0]?.criticalPathMs, 12_000);
});

test("bounds loop evidence for hostile repeated input", () => {
  const spans = [span("root"), ...Array.from({ length: 150 }, (_, index) => span(`call-${index}`, {
    parentId: "root", kind: "tool", tool: "repeat", startMs: index,
  }))];
  const report = analyzeSpans(spans);
  assert.equal(report.loops[0]?.spanIds.length, 100);
  assert.ok(report.warnings.some((warning) => warning.includes("Loop evidence")));
});

test("redacts report-wide identifiers and aggregate labels while preserving relationships", () => {
  const secretId = "alice@example.test";
  const report = analyzeSpans([
    span(secretId, { traceId: secretId, kind: "model", model: "sk-abcdefghijklmnop" }),
    span("child", { traceId: secretId, parentId: secretId }),
  ], { title: "Bearer abcdefghijklmnop", source: "alice@example.test.json" });
  assert.ok(!JSON.stringify(report).includes("alice@example.test"));
  assert.ok(!JSON.stringify(report).includes("abcdefghijklmnop"));
  assert.equal(report.spans[1]?.parentId, report.spans[0]?.id);
  assert.equal(report.traces[0]?.id, report.spans[0]?.traceId);
  assert.equal(report.usage[0]?.name, "[REDACTED]");
});

test("groups generic session IDs but aliases them whenever default redaction is enabled", () => {
  const adapted = adaptSpans({ spans: [
    { id: "one", session_id: "opaque-customer-session", name: "one" },
    { id: "two", session_id: "opaque-customer-session", name: "two" },
  ] });
  assert.equal(adapted[0]?.traceId, "opaque-customer-session");
  const safe = analyzeSpans(adapted);
  assert.notEqual(safe.traces[0]?.id, "opaque-customer-session");
  assert.equal(safe.spans[0]?.traceId, safe.traces[0]?.id);
  assert.equal(analyzeSpans(adapted, { redact: false }).traces[0]?.id, "opaque-customer-session");
});

test("rejects invalid normalized numbers before report generation", () => {
  assert.throws(() => analyzeSpans([span("bad", { durationMs: Number.POSITIVE_INFINITY })]), /non-finite durationMs/u);
  assert.throws(() => analyzeSpans([span("bad", { inputTokens: Number.MAX_SAFE_INTEGER + 1 })]), /invalid inputTokens/u);
  assert.throws(() => analyzeSpans([span("bad", { status: "maybe" as "ok" })]), /invalid status/u);
});
