import assert from "node:assert/strict";
import test from "node:test";
import { parsePricing, pricingRate } from "../src/pricing.js";

test("validates local pricing and resolves exact, case-insensitive, and fallback rates", () => {
  const pricing = parsePricing({ models: { Alpha: { inputPerMillion: 1, outputPerMillion: 3 }, "*": { inputPerMillion: 2, outputPerMillion: 4 } } });
  assert.deepEqual(pricingRate(pricing, "alpha"), { inputPerMillion: 1, outputPerMillion: 3 });
  assert.deepEqual(pricingRate(pricing, "unknown"), { inputPerMillion: 2, outputPerMillion: 4 });
});

test("rejects negative, incomplete, and non-USD rates", () => {
  assert.throws(() => parsePricing({ models: { x: { inputPerMillion: -1, outputPerMillion: 2 } } }), /Invalid inputPerMillion/u);
  assert.throws(() => parsePricing({ models: { x: { inputPerMillion: 1 } } }), /Invalid outputPerMillion/u);
  assert.throws(() => parsePricing({ currency: "EUR", models: { x: { inputPerMillion: 1, outputPerMillion: 2 } } }), /Only USD/u);
});
