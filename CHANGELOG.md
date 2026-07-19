# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- A documented ESM package entry point and packed-artifact CI smoke test.
- OTLP `kvlistValue`, fractional nanosecond, forward-parent, nested trace inheritance, and `parent_run_id` coverage.

### Changed

- GitHub Actions are pinned to immutable full commit SHAs.
- Loop evidence is bounded with an explicit report warning when truncated.

### Fixed

- Preserve parent relationships when raw span IDs repeat across traces or parents appear later in the input.
- Replace recursive input, graph, critical-path, and loop traversal with bounded iterative implementations for deeply nested traces.
- Apply default redaction across identifiers, metadata, usage rows, and loop findings, including additional credential patterns.
- Neutralize terminal control sequences and Markdown syntax from untrusted trace text; strengthen the HTML CSP.
- Scope orphan detection to each trace and guard numeric aggregation, cost overflow, and prototype-shaped pricing names.

## [0.1.0] - 2026-07-19

### Added

- Tolerant adapters for generic JSON, JSONL, gzip, and OpenTelemetry GenAI spans.
- Deterministic trace trees, critical paths, retry/loop hints, latency, error, token, and usage summaries.
- Opt-in cost estimates driven exclusively by a local pricing file.
- Terminal, JSON, Markdown, and self-contained interactive HTML reports.
- Default redaction and a decompressed input-size boundary.
