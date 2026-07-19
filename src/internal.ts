import type { NormalizedSpan } from "./types.js";

export const SENSITIVE_TRACE_ID: unique symbol = Symbol("spangarden.sensitiveTraceId");

export type InternalSpan = NormalizedSpan & { [SENSITIVE_TRACE_ID]?: true };
