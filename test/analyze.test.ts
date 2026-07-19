import assert from "node:assert/strict";
import test from "node:test";
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

test("warns about missing parent and timing data", () => {
  const report = analyzeSpans([span("orphan", { parentId: "gone", startMs: 0, endMs: 0, durationMs: 0 })]);
  assert.equal(report.traces[0]?.rootIds[0], "orphan");
  assert.equal(report.warnings.length, 2);
});
