# Security policy

## Supported versions

The latest minor release receives security fixes.

## Reporting a vulnerability

Please use GitHub's **Report a vulnerability** private advisory flow. Do not open a public issue with exploit details, real traces, prompts, access tokens, or personal data. You should receive an acknowledgement within seven days.

## Data-handling model

SpanGarden runs locally and makes no network requests. Redaction is defense in depth, not a guarantee: inspect reports before sharing them. Input is untrusted, HTML content is encoded before embedding, output paths are user-controlled, gzip is bounded after decompression, and pricing data never leaves the machine.
