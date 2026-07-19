import { writeFile } from "node:fs/promises";
import { adaptSpans } from "../dist/src/adapter.js";
import { analyzeSpans } from "../dist/src/analyze.js";
import { demoTrace } from "../dist/src/demo.js";
import { formatReport } from "../dist/src/format.js";
import { parsePricing } from "../dist/src/pricing.js";

const pricing = parsePricing({
  currency: "USD",
  models: {
    "orchid-2-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 },
    "orchid-2": { inputPerMillion: 2, outputPerMillion: 8 }
  }
});
const report = analyzeSpans(adaptSpans(demoTrace), {
  title: "A travel agent, from seed to signal",
  source: "synthetic OpenTelemetry GenAI demo",
  pricing
});
await writeFile(new URL("../docs/index.html", import.meta.url), formatReport(report, "html"), "utf8");
