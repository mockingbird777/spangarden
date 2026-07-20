#!/usr/bin/env node
import { basename, dirname, extname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { stderr, stdout } from "node:process";
import { adaptSpans } from "./adapter.js";
import { analyzeSpans } from "./analyze.js";
import { demoTrace } from "./demo.js";
import { formatReport } from "./format.js";
import { DEFAULT_MAX_BYTES, loadInput } from "./input.js";
import { loadPricing } from "./pricing.js";
import type { OutputFormat } from "./types.js";
import { VERSION } from "./version.js";

interface CliOptions {
  input?: string;
  format: OutputFormat;
  output?: string;
  pricing?: string;
  title?: string;
  maxBytes: number;
  redact: boolean;
  demo: boolean;
  failOnErrors: boolean;
}

const HELP = `SpanGarden ${VERSION} — local-first AI agent trace analysis

Usage:
  spangarden <trace.json|trace.jsonl|trace.json.gz|-> [options]
  spangarden --demo --format html --output report.html

Options:
  -f, --format <type>    terminal, json, markdown, or html (default: terminal,
                         or inferred from the --output file extension)
  -o, --output <path>   Write atomically to a file instead of stdout
      --pricing <path>  Local USD pricing JSON; no prices are fetched
      --title <text>     Report title
      --max-bytes <n>   Max decompressed input bytes (default: ${DEFAULT_MAX_BYTES})
      --no-redact       Keep sensitive-looking fields (use with care)
      --fail-on-errors  Exit 2 after writing when error spans are present
      --demo            Analyze the built-in synthetic trace
  -v, --version         Print the version
  -h, --help            Show this help

Pricing shape:
  {"models":{"model-name":{"inputPerMillion":1,"outputPerMillion":4}}}

SpanGarden performs no network requests. JSON/JSONL input is bounded after
gzip decompression, and HTML reports are self-contained.
`;

const EXTENSION_FORMATS: Readonly<Record<string, OutputFormat>> = {
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".md": "markdown",
  ".markdown": "markdown",
};

function parseArgs(args: string[]): CliOptions | "help" | "version" {
  const result: CliOptions = { format: "terminal", maxBytes: DEFAULT_MAX_BYTES, redact: true, demo: false, failOnErrors: false };
  let formatExplicit = false;
  const take = (flag: string, index: number, allowDash = false): string => {
    const value = args[index + 1];
    if (value === undefined || (value.startsWith("-") && !(allowDash && value === "-"))) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--version" || arg === "-v") return "version";
    if (arg === "--demo") result.demo = true;
    else if (arg === "--no-redact") result.redact = false;
    else if (arg === "--fail-on-errors") result.failOnErrors = true;
    else if (arg === "--format" || arg === "-f") {
      const value = take(arg, index);
      if (!(["terminal", "json", "markdown", "html"] as string[]).includes(value)) throw new Error(`Unknown format: ${value}`);
      result.format = value as OutputFormat;
      formatExplicit = true;
      index += 1;
    } else if (arg === "--output" || arg === "-o") {
      result.output = take(arg, index, true);
      index += 1;
    } else if (arg === "--pricing") {
      result.pricing = take(arg, index);
      index += 1;
    } else if (arg === "--title") {
      result.title = take(arg, index);
      index += 1;
    } else if (arg === "--max-bytes") {
      const value = Number(take(arg, index));
      if (!Number.isSafeInteger(value) || value < 1024 || value > 1024 * 1024 * 1024) throw new Error("--max-bytes must be an integer from 1024 to 1073741824");
      result.maxBytes = value;
      index += 1;
    } else if (arg === "-" && result.input === undefined) result.input = arg;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (result.input === undefined) result.input = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (result.demo && result.input !== undefined) throw new Error("Use either an input path or --demo, not both");
  if (!result.demo && result.input === undefined) throw new Error("Provide a trace path, '-' for stdin, or --demo");
  // An explicit --format always wins; otherwise a recognised --output file
  // extension picks the format. Stdout ("-"), unknown, and missing
  // extensions keep the terminal default.
  if (!formatExplicit && result.output !== undefined && result.output !== "-") {
    const inferred = EXTENSION_FORMATS[extname(result.output).toLowerCase()];
    if (inferred !== undefined) result.format = inferred;
  }
  return result;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const target = resolve(path);
  const temporary = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function run(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    stdout.write(HELP);
    return;
  }
  if (parsed === "version") {
    stdout.write(`${VERSION}\n`);
    return;
  }
  const source = parsed.demo ? "built-in synthetic demo" : parsed.input === "-" ? "stdin" : basename(parsed.input as string);
  const raw = parsed.demo ? demoTrace : await loadInput(parsed.input as string, parsed.maxBytes);
  const pricing = parsed.pricing === undefined ? undefined : await loadPricing(parsed.pricing);
  if (!parsed.redact) stderr.write("SpanGarden warning: redaction is OFF; inspect the report before sharing it.\n");
  const report = analyzeSpans(adaptSpans(raw), {
    source,
    redact: parsed.redact,
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
    ...(pricing === undefined ? {} : { pricing }),
  });
  const output = formatReport(report, parsed.format);
  if (parsed.output === undefined || parsed.output === "-") stdout.write(output);
  else {
    await atomicWrite(parsed.output, output);
    stderr.write(`SpanGarden wrote ${parsed.format} to ${parsed.output}\n`);
  }
  if (parsed.failOnErrors && report.summary.errors > 0) process.exitCode = 2;
}

process.on("SIGPIPE", () => {
  process.exitCode = 0;
});

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`SpanGarden: ${message}\n`);
  if (process.env.SPANGARDEN_DEBUG === "1" && error instanceof Error && error.stack !== undefined) stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
