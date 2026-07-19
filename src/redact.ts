import { createHash } from "node:crypto";
import { SENSITIVE_TRACE_ID, type InternalSpan } from "./internal.js";
import type { JsonObject, JsonValue, NormalizedSpan } from "./types.js";

export const REDACTED = "[REDACTED]";

const metricTokenKey = /(?:^|[._-])(?:input|output|total|cached|reasoning)[._-]?tokens?$/iu;
const sensitiveKey = /(?:api[._-]?key|authorization|auth[._-]?token|access[._-]?token|refresh[._-]?token|id[._-]?token|password|passwd|secret|cookie|session[._-]?id|private[._-]?key|client[._-]?secret|(?:^|[._-])(?:token|key|email|e[._-]?mail)(?:$|[._-])|(?:^|[._-])prompts?(?:$|[._-])|(?:^|[._-])messages?(?:$|[._-])|message[._-]?content|(?:gen[._-]?ai[._-]?)?(?:input|output)[._-]?(?:value|messages?))/iu;

export function isSensitiveKey(key: string): boolean {
  return !metricTokenKey.test(key) && sensitiveKey.test(key);
}

export function redactString(value: string): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, REDACTED)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu, REDACTED)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu, REDACTED)
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/gu, REDACTED)
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, REDACTED)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, REDACTED)
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gu, REDACTED)
    .replace(/([?&](?:api[._-]?key|key|token|access[._-]?token|secret|signature)=)[^&#\s]+/giu, `$1${encodeURIComponent(REDACTED)}`);
}

export function redactIdentifier(value: string, prefix: "span" | "trace", force = false): string {
  if (!force && redactString(value) === value) return value;
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
  return `${prefix}-redacted-${digest}`;
}

function redactKey(key: string): string {
  if (redactString(key) === key) return key;
  const digest = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
  return `redacted-key-${digest}`;
}

export function redactValue(value: JsonValue, key = ""): JsonValue {
  if (isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value !== null && typeof value === "object") {
    const output: JsonObject = {};
    for (const childKey of Object.keys(value).sort()) {
      Object.defineProperty(output, redactKey(childKey), {
        value: redactValue(value[childKey] as JsonValue, childKey),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return output;
  }
  return value;
}

export function redactSpan(span: NormalizedSpan): NormalizedSpan {
  return {
    ...span,
    id: redactIdentifier(span.id, "span"),
    traceId: redactIdentifier(span.traceId, "trace", (span as InternalSpan)[SENSITIVE_TRACE_ID] === true),
    ...(span.parentId === undefined ? {} : { parentId: redactIdentifier(span.parentId, "span") }),
    name: redactString(span.name),
    ...(span.model === undefined ? {} : { model: redactString(span.model) }),
    ...(span.tool === undefined ? {} : { tool: redactString(span.tool) }),
    attributes: redactValue(span.attributes) as JsonObject,
  };
}
