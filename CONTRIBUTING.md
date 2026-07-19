# Contributing to SpanGarden

Thank you for helping make agent traces easier to understand.

## Development

Requirements: Node.js 20+ and npm.

```bash
git clone https://github.com/mockingbird777/spangarden.git
cd spangarden
npm ci
npm test
```

Keep adapters tolerant, outputs deterministic, and runtime dependencies minimal. Add a focused fixture and test for every parser or analysis change. Never commit real prompts, credentials, customer traces, or identifying telemetry.

## Pull requests

1. Open an issue for large behavior changes.
2. Keep commits scoped and explain user-visible trade-offs.
3. Run `npm run check`, `npm test`, and `npm audit`.
4. Update the README and changelog when behavior changes.

By contributing, you agree that your work is released under the MIT License and that you will follow the code of conduct.
