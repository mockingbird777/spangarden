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

test("rejects input without recognizable spans", () => {
  assert.throws(() => adaptSpans({ hello: "garden" }), /No trace spans found/u);
});
