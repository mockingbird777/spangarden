import assert from "node:assert/strict";
import test from "node:test";
import { adaptSpans } from "../src/adapter.js";

test("adapts generic camelCase and snake_case spans", () => {
  const spans = adaptSpans({ spans: [
    { id: "root", trace_id: "t", name: "agent run", start_time: 100, duration_ms: 50, status: "success" },
    { spanId: "child", parentSpanId: "root", traceId: "t", name: "chat", model: "m", input_tokens: 12, output_tokens: 4, durationMs: 20 },
  ] });
  assert.equal(spans.length, 2);
  assert.equal(spans[0]?.status, "ok");
  assert.equal(spans[1]?.parentId, "root");
  assert.equal(spans[1]?.kind, "model");
  assert.equal(spans[1]?.inputTokens, 12);
  assert.equal(spans[1]?.outputTokens, 4);
});

test("gives explicit semantic kinds precedence over ambiguous span names", () => {
  const spans = adaptSpans({ spans: [
    { id: "agent", name: "model routing workflow", run_type: "chain", usage: { input_tokens: 8, output_tokens: 3 }, error: { message: "failed" } },
    { id: "retrieval", name: "model context", attributes: { "openinference.span.kind": "RETRIEVER" } },
  ] });
  assert.equal(spans[0]?.kind, "agent");
  assert.equal(spans[0]?.inputTokens, 8);
  assert.equal(spans[0]?.outputTokens, 3);
  assert.equal(spans[0]?.status, "error");
  assert.equal(spans[1]?.kind, "retrieval");
});

test("decodes OpenTelemetry GenAI spans and resource attributes", () => {
  const spans = adaptSpans({ resourceSpans: [{
    resource: { attributes: [{ key: "service.name", value: { stringValue: "agent-api" } }] },
    scopeSpans: [{ spans: [{
      traceId: "otel-t", spanId: "otel-s", name: "chat completion",
      startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000250000000",
      attributes: [
        { key: "gen_ai.request.model", value: { stringValue: "model-x" } },
        { key: "gen_ai.usage.input_tokens", value: { intValue: 40 } },
        { key: "gen_ai.usage.output_tokens", value: { intValue: 9 } },
      ], status: { code: 2 },
    }] }],
  }] });
  assert.equal(spans[0]?.startMs, 1_700_000_000_000);
  assert.equal(spans[0]?.durationMs, 250);
  assert.equal(spans[0]?.model, "model-x");
  assert.equal(spans[0]?.status, "error");
  assert.equal(spans[0]?.attributes["service.name"], "agent-api");
});

test("decodes OTLP kvlist attributes and preserves sub-millisecond nanosecond timing", () => {
  const spans = adaptSpans({ resourceSpans: [{ scopeSpans: [{ spans: [{
    traceId: "t",
    spanId: "s",
    name: "chat",
    startTimeUnixNano: "1700000000000123456",
    endTimeUnixNano: "1700000000001123456",
    attributes: [
      { key: "gen_ai.request.parameters", value: { kvlistValue: { values: [
        { key: "temperature", value: { doubleValue: 0.2 } },
        { key: "stream", value: { boolValue: true } },
      ] } } },
      { key: "__proto__", value: { stringValue: "ordinary-data" } },
    ],
  }] }] }] });
  assert.ok(Math.abs((spans[0]?.startMs ?? 0) - 1_700_000_000_000.1235) < 0.001);
  assert.ok(Math.abs((spans[0]?.durationMs ?? 0) - 1) < 0.001);
  assert.deepEqual(spans[0]?.attributes["gen_ai.request.parameters"], { stream: true, temperature: 0.2 });
  assert.equal(Object.hasOwn(spans[0]?.attributes ?? {}, "__proto__"), true);
  assert.equal(spans[0]?.attributes.__proto__, "ordinary-data");
});

test("links nested generic children to their enclosing span", () => {
  const spans = adaptSpans({ id: "outer", name: "agent workflow", duration_ms: 20, children: [
    { id: "inner", name: "function call", duration_ms: 5, tool_name: "lookup" },
  ] });
  assert.equal(spans[1]?.parentId, "outer");
  assert.equal(spans[1]?.tool, "lookup");
  assert.equal(spans[1]?.kind, "tool");
});

test("assigns deterministic IDs and resolves duplicates", () => {
  const first = adaptSpans([{ name: "step", duration_ms: 1 }, { id: "same", name: "a" }, { id: "same", name: "b" }]);
  const second = adaptSpans([{ name: "step", duration_ms: 1 }, { id: "same", name: "a" }, { id: "same", name: "b" }]);
  assert.deepEqual(first.map((item) => item.id), ["span-1", "same", "same-2"]);
  assert.deepEqual(first, second);
});

test("keeps duplicate raw IDs in separate traces linked to the correct normalized parent", () => {
  const spans = adaptSpans({ spans: [
    { spanId: "root", traceId: "a", name: "root" },
    { spanId: "child", parentSpanId: "root", traceId: "a", name: "child" },
    { spanId: "root", traceId: "b", name: "root" },
    { spanId: "child", parentSpanId: "root", traceId: "b", name: "child" },
  ] });
  assert.deepEqual(spans.map((item) => [item.id, item.parentId]), [
    ["root", undefined], ["child", "root"], ["root-2", undefined], ["child-2", "root-2"],
  ]);
});

test("resolves forward parents and links id-less nested spans in the enclosing trace", () => {
  const forward = adaptSpans({ spans: [
    { id: "child", parent_id: "root", trace_id: "t", name: "child" },
    { id: "root", trace_id: "t", name: "root" },
  ] });
  assert.equal(forward[0]?.parentId, "root");

  const nested = adaptSpans({ traceId: "nested-trace", name: "root", duration_ms: 2, children: [
    { name: "child", duration_ms: 1 },
  ] });
  assert.equal(nested[0]?.id, "span-1");
  assert.equal(nested[1]?.parentId, "span-1");
  assert.equal(nested[1]?.traceId, "nested-trace");
});

test("does not misclassify ID-only wrappers and handles cyclic or deeply nested API input", () => {
  const wrapped = adaptSpans({ id: "wrapper", spans: [{ id: "real", name: "span" }] });
  assert.deepEqual(wrapped.map((item) => item.id), ["real"]);

  const cyclic: { id: string; name: string; children: unknown[] } = { id: "cycle", name: "cycle", children: [] };
  cyclic.children.push(cyclic);
  assert.equal(adaptSpans(cyclic).length, 1);

  let deep: unknown = { name: "leaf", duration_ms: 1 };
  for (let index = 0; index < 10_000; index += 1) deep = { name: `node-${index}`, duration_ms: 1, children: [deep] };
  const spans = adaptSpans(deep);
  assert.equal(spans.length, 10_001);
  assert.equal(spans.at(-1)?.parentId, spans.at(-2)?.id);
});

test("rejects input without recognizable spans", () => {
  assert.throws(() => adaptSpans({ hello: "garden" }), /No trace spans found/u);
});
