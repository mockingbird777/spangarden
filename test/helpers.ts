import type { JsonObject, NormalizedSpan } from "../src/types.js";

export function span(id: string, overrides: Partial<NormalizedSpan> = {}): NormalizedSpan {
  return {
    id,
    traceId: "trace-a",
    name: id,
    kind: "other",
    startMs: 0,
    endMs: 10,
    durationMs: 10,
    status: "ok",
    inputTokens: 0,
    outputTokens: 0,
    attributes: {} as JsonObject,
    ...overrides,
  };
}
