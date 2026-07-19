import type { JsonObject, JsonValue, NormalizedSpan } from "./types.js";

export const REDACTED = "[REDACTED]";

const metricTokenKey = /(?:^|[._-])(?:input|output|total|cached|reasoning)[._-]?tokens?$/iu;
const sensitiveKey = /(?:api[._-]?key|authorization|auth[._-]?token|access[._-]?token|refresh[._-]?token|password|passwd|secret|cookie|session[._-]?id|private[._-]?key|client[._-]?secret|(?:^|[._-])prompt(?:$|[._-])|message[._-]?content|(?:gen[._-]?ai[._-]?)?(?:input|output)[._-]?(?:value|messages?))/iu;

export function isSensitiveKey(key: string): boolean {
  return !metricTokenKey.test(key) && sensitiveKey.test(key);
}

function redactString(value: string): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, REDACTED)
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, REDACTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, REDACTED)
    .replace(/([?&](?:key|token|secret|signature)=)[^&#\s]+/giu, `$1${encodeURIComponent(REDACTED)}`);
}

export function redactValue(value: JsonValue, key = ""): JsonValue {
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value !== null && typeof value === "object") {
    const output: JsonObject = {};
    for (const childKey of Object.keys(value).sort()) {
      output[childKey] = redactValue(value[childKey] as JsonValue, childKey);
    }
    return output;
  }
  return value;
}

export function redactSpan(span: NormalizedSpan): NormalizedSpan {
  return {
    ...span,
    name: redactString(span.name),
    ...(span.model === undefined ? {} : { model: redactString(span.model) }),
    ...(span.tool === undefined ? {} : { tool: redactString(span.tool) }),
    attributes: redactValue(span.attributes) as JsonObject,
  };
}
