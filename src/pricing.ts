import { readFile, stat } from "node:fs/promises";
import type { PricingFile, PricingRate } from "./types.js";

const MAX_PRICING_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRate(value: unknown, name: string): PricingRate {
  if (!isRecord(value)) throw new Error(`Pricing rate for ${name} must be an object`);
  const input = value.inputPerMillion;
  const output = value.outputPerMillion;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) throw new Error(`Invalid inputPerMillion for ${name}`);
  if (typeof output !== "number" || !Number.isFinite(output) || output < 0) throw new Error(`Invalid outputPerMillion for ${name}`);
  return { inputPerMillion: input, outputPerMillion: output };
}

export function parsePricing(value: unknown): PricingFile {
  if (!isRecord(value) || !isRecord(value.models)) throw new Error("Pricing JSON must contain a models object");
  if (value.currency !== undefined && value.currency !== "USD") throw new Error("Only USD pricing is currently supported");
  const models: Record<string, PricingRate> = {};
  for (const name of Object.keys(value.models).sort()) models[name] = parseRate(value.models[name], name);
  if (Object.keys(models).length === 0) throw new Error("Pricing models cannot be empty");
  return { currency: "USD", models };
}

export async function loadPricing(path: string): Promise<PricingFile> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Pricing input is not a file: ${path}`);
  if (info.size > MAX_PRICING_BYTES) throw new Error("Pricing input exceeds 1 MiB");
  const text = await readFile(path, "utf8");
  try {
    return parsePricing(JSON.parse(text) as unknown);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid pricing JSON: ${detail}`);
  }
}

export function pricingRate(pricing: PricingFile, model: string): PricingRate | undefined {
  if (pricing.models[model] !== undefined) return pricing.models[model];
  const match = Object.keys(pricing.models).find((candidate) => candidate.toLowerCase() === model.toLowerCase());
  return match === undefined ? pricing.models["*"] : pricing.models[match];
}
