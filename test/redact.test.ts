import assert from "node:assert/strict";
import test from "node:test";
import { isSensitiveKey, redactValue, REDACTED } from "../src/redact.js";

test("redacts nested sensitive keys but preserves token metrics", () => {
  const result = redactValue({
    api_key: "sk-example123456789",
    nested: { clientSecret: "hidden", "gen_ai.usage.input_tokens": 42 },
    output_tokens: 9,
  }) as Record<string, unknown>;
  assert.equal(result.api_key, REDACTED);
  assert.deepEqual(result.nested, { clientSecret: REDACTED, "gen_ai.usage.input_tokens": 42 });
  assert.equal(result.output_tokens, 9);
});

test("masks credential patterns embedded in ordinary strings", () => {
  const value = redactValue("Authorization: Bearer abc.def-123456 and sk-abcdefghijklmnop plus ?token=secret-value") as string;
  assert.ok(!value.includes("abc.def"));
  assert.ok(!value.includes("sk-abcdefghijklmnop"));
  assert.ok(!value.includes("secret-value"));
  assert.ok(value.includes(REDACTED));
});

test("classifies sensitive names conservatively", () => {
  assert.equal(isSensitiveKey("http.request.header.authorization"), true);
  assert.equal(isSensitiveKey("private-key"), true);
  assert.equal(isSensitiveKey("input_tokens"), false);
  assert.equal(isSensitiveKey("reasoning.tokens"), false);
  assert.equal(isSensitiveKey("gen_ai.input.messages"), true);
  assert.equal(isSensitiveKey("prompt.preview"), true);
});

test("masks email addresses in free-form attributes", () => {
  assert.equal(redactValue("Contact person@example.test for details"), `Contact ${REDACTED} for details`);
});
