# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Normalize `durationNs`/`duration_ns` nanosecond duration fields to milliseconds, after the existing millisecond fields.

## [0.1.1] - 2026-07-20

### Added

- A documented ESM package entry point and packed-artifact CI smoke test.
- OTLP `kvlistValue`, fractional nanosecond, forward-parent, nested trace inheritance, and `parent_run_id` coverage.
- Add clear GitHub source and star links to generated interactive reports.
- Add a 1280×640 repository social preview and a question-led first-visit README.

### Changed

- GitHub Actions are pinned to immutable full commit SHAs.
- Loop evidence is bounded with an explicit report warning when truncated.

### Fixed

- Preserve parent relationships when raw span IDs repeat across traces or parents appear later in the input.
- Replace recursive input, graph, critical-path, and loop traversal with bounded iterative implementations for deeply nested traces.
- Apply default redaction across identifiers, metadata, usage rows, and loop findings, including additional credential patterns.
- Neutralize terminal control sequences and Markdown syntax from untrusted trace text; strengthen the HTML CSP.
- Scope orphan detection to each trace and guard numeric aggregation, cost overflow, and prototype-shaped pricing names.
- Accept the documented `-` stdin target and `--output -` stdout target in the CLI.

## [0.1.0] - 2026-07-19

### Added

- Tolerant adapters for generic JSON, JSONL, gzip, and OpenTelemetry GenAI spans.
- Deterministic trace trees, critical paths, retry/loop hints, latency, error, token, and usage summaries.
- Opt-in cost estimates driven exclusively by a local pricing file.
- Terminal, JSON, Markdown, and self-contained interactive HTML reports.
- Default redaction and a decompressed input-size boundary.

[Unreleased]: https://github.com/mockingbird777/spangarden/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/mockingbird777/spangarden/releases/tag/v0.1.1
[0.1.0]: https://github.com/mockingbird777/spangarden/releases/tag/v0.1.0
