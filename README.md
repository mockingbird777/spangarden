<div align="center">

# 🌱 SpanGarden

### Grow raw agent traces into answers you can act on.

**A local-first CLI for critical paths, retry loops, model/tool usage, tokens, errors, latency, and opt-in cost estimates.**

[![CI](https://github.com/mockingbird777/spangarden/actions/workflows/ci.yml/badge.svg)](https://github.com/mockingbird777/spangarden/actions/workflows/ci.yml)
[![Pages](https://github.com/mockingbird777/spangarden/actions/workflows/pages.yml/badge.svg)](https://mockingbird777.github.io/spangarden/)
[![Node 20+](https://img.shields.io/badge/Node.js-20%2B-5fa04e)](https://nodejs.org/)
[![MIT](https://img.shields.io/badge/license-MIT-82f6b3)](LICENSE)
[![zero runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-72d8ee)](package.json)

[**Explore the live report →**](https://mockingbird777.github.io/spangarden/) · [Quick start](#quick-start) · [Input adapters](#input-adapters) · [Privacy](#privacy-by-default)

</div>

---

Agent traces are rich and awkward: nested spans, vendor-shaped attributes, retries that look like normal calls, and token numbers without context. SpanGarden turns those exports into one reproducible report on your machine—no collector, database, Docker image, account, or cloud upload.

```text
  SPANGARDEN  Travel planner investigation
  ──────────────────────────────────────────────────────────────
  1 traces   6 spans   2 errors   2 retry candidates
  2.85s wall time   p50 280ms   p95 2.85s
  3,420 in / 1,196 out tokens

  CRITICAL PATHS
  garden-demo-01  3.93s  agent.plan_trip → chat final answer

  USAGE
  model  orchid-2                   1 calls     1.08s  0 err  $0.010360
  tool   weather                    3 calls      720ms  2 err
```

## Why SpanGarden

| Question | Signal |
|---|---|
| Where did the run spend time? | Per-trace trees, wall time, p50/p95, and longest root-to-leaf critical path |
| Is the agent stuck? | Recursive-path and repeated-sibling loop signals plus retry candidates |
| Which tools and models dominate? | Deterministic call, error, latency, and token rollups |
| What might this run cost? | Estimates from **your local pricing JSON only**—never stale bundled prices |
| Can I share the report? | Sensitive-key and credential-pattern redaction is on by default; HTML embeds encoded data |
| Will this become infrastructure? | No daemon, no network calls, and zero runtime dependencies |

## Quick start

Run directly from GitHub with Node.js 20+:

```bash
npx --yes github:mockingbird777/spangarden --demo
npx --yes github:mockingbird777/spangarden ./trace.json --format html --output report.html
```

Or clone for repeat use:

```bash
git clone https://github.com/mockingbird777/spangarden.git
cd spangarden
npm ci
npm run build
node dist/src/cli.js examples/agent-run.json --pricing examples/pricing.json
```

Generate every report shape:

```bash
spangarden run.jsonl --format terminal
spangarden run.json.gz --format json --output report.json
spangarden run.json --format markdown --output investigation.md
spangarden run.json --format html --output investigation.html
cat run.jsonl | spangarden - --format json
```

The HTML report is one portable file with search, kind filters, critical-path highlighting, usage tables, and loop evidence. It loads no remote assets.

## What it analyzes

- Parent/child span forests, including missing-parent and cyclic-input recovery
- Longest duration-weighted root-to-leaf path per trace
- Model and tool calls, errors, durations, input tokens, and output tokens
- Repeated siblings as retry candidates; three or more as a loop signal
- Repeated operations along an ancestor path as a recursive-loop signal
- Trace wall time and p50/p95 span latency
- Optional per-model cost estimates with priced/unpriced token accounting

Loop and retry results are deliberately labeled **signals** and **candidates**. They guide an investigation; they do not pretend to know application intent.

## Input adapters

SpanGarden accepts regular JSON, newline-delimited JSON, and gzip files ending in `.gz`. The adapter searches these common containers:

- OpenTelemetry `resourceSpans → scopeSpans → spans`
- Legacy `instrumentationLibrarySpans`
- Generic `spans`, `traces`, `runs`, `events`, `children`, and `steps`
- Top-level span arrays and JSONL span records

Common snake_case and camelCase IDs, parents, timestamps, durations, statuses, models, tools, and token fields are normalized. OpenTelemetry attribute arrays and value wrappers are decoded. Unknown attributes stay in the report instead of being thrown away.

Minimal generic input:

```json
{
  "spans": [
    { "id": "run", "trace_id": "t1", "name": "agent.run", "start_time": 0, "duration_ms": 840 },
    { "id": "llm", "parent_id": "run", "trace_id": "t1", "name": "chat", "model": "my-model", "duration_ms": 620, "input_tokens": 900, "output_tokens": 220 }
  ]
}
```

Timestamp support includes ISO strings, millisecond numbers, and OpenTelemetry Unix nanosecond fields. When timestamps are absent, analysis continues and adds a warning.

## Local pricing

SpanGarden does **not** ship or fetch model prices. Supply rates you have reviewed:

```json
{
  "currency": "USD",
  "models": {
    "my-model": { "inputPerMillion": 2, "outputPerMillion": 8 },
    "*": { "inputPerMillion": 0.5, "outputPerMillion": 1.5 }
  }
}
```

```bash
spangarden trace.json --pricing pricing.json --format html -o report.html
```

Exact model names are preferred, matching is case-insensitive, and `*` is an optional fallback. Unmatched tokens are reported as unpriced. Estimates are arithmetic aids, not billing records.

## Privacy by default

SpanGarden performs no network requests. Before output, it redacts sensitive-looking keys such as prompts/message content, authorization headers, API keys, passwords, cookies, private keys, and session IDs. It also masks common bearer credentials, `sk-…` keys, AWS access IDs, JWTs, email addresses, and secret-bearing URL parameters inside strings.

Token **count** fields are preserved. Redaction can miss domain-specific data, so inspect artifacts before sharing them.

```bash
# Only for controlled local debugging; a warning is written to stderr.
spangarden trace.json --no-redact
```

Input is bounded to 128 MiB **after gzip decompression** by default. Change the limit explicitly:

```bash
spangarden large.jsonl.gz --max-bytes 268435456
```

## CLI reference

```text
spangarden <trace.json|trace.jsonl|trace.json.gz|-> [options]

-f, --format <type>    terminal, json, markdown, or html
-o, --output <path>   atomically write a file (mode 0600)
    --pricing <path>  local USD pricing JSON (maximum 1 MiB)
    --title <text>     report title
    --max-bytes <n>   decompressed input limit
    --no-redact       disable default redaction
    --fail-on-errors  write the report, then exit with status 2 on error spans
    --demo            analyze a built-in synthetic OTel trace
```

Machine-readable reports use schema version `1.0`. Results are sorted and the report timestamp is anchored to trace data, making repeated analysis byte-for-byte reproducible for the same inputs and options.

## Development

```bash
npm ci
npm run check
npm test
npm run docs
npm audit
```

The implementation uses strict TypeScript and Node's standard library. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [changelog](CHANGELOG.md).

## Roadmap

- Streaming aggregation mode for traces larger than the in-memory analysis boundary
- Additional semantic-convention adapters and adapter diagnostics
- Critical-path self-time alongside duration-weighted chain analysis
- Diff mode for comparing two agent runs

If SpanGarden makes a difficult agent run legible, consider starring it—and share a synthetic fixture for the next adapter. 🌿
