import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

interface RunResult { code: number | null; stdout: string; stderr: string }

async function run(args: string[], input?: string): Promise<RunResult> {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve("dist/src/cli.js"), ...args], { cwd: process.cwd() });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout: out, stderr: err }));
    child.stdin.end(input);
  });
}

test("runs the built-in demo as machine-readable JSON", async () => {
  const result = await run(["--demo", "--format", "json"]);
  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout) as { summary: { spans: number; errors: number }; redacted: boolean };
  assert.equal(report.summary.spans, 6);
  assert.equal(report.summary.errors, 2);
  assert.equal(report.redacted, true);
  assert.equal(result.stderr, "");
});

test("accepts documented stdin input and an explicit stdout output target", async () => {
  const input = JSON.stringify({ spans: [{ id: "run", name: "agent.run", duration_ms: 20 }] });
  const piped = await run(["-", "--format", "json"], input);
  assert.equal(piped.code, 0, piped.stderr);
  const report = JSON.parse(piped.stdout) as { source: string; summary: { spans: number } };
  assert.equal(report.source, "stdin");
  assert.equal(report.summary.spans, 1);

  const explicitStdout = await run(["--demo", "--format", "json", "--output", "-"]);
  assert.equal(explicitStdout.code, 0, explicitStdout.stderr);
  assert.equal((JSON.parse(explicitStdout.stdout) as { summary: { spans: number } }).summary.spans, 6);
});

test("writes output atomically with owner-only file permissions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "spangarden-cli-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "report.html");
  const result = await run(["--demo", "--format", "html", "--output", output]);
  assert.equal(result.code, 0);
  assert.match(await readFile(output, "utf8"), /<!doctype html>/u);
  if (process.platform !== "win32") {
    assert.equal((await stat(output)).mode & 0o777, 0o600);
  }
  assert.match(result.stderr, /wrote html/u);
});

test("can fail CI after still emitting a report", async () => {
  const result = await run(["--demo", "--format", "json", "--fail-on-errors"]);
  assert.equal(result.code, 2);
  assert.equal((JSON.parse(result.stdout) as { summary: { errors: number } }).summary.errors, 2);
});

test("prints concise usage errors and version", async () => {
  const invalid = await run(["--unknown"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /Unknown option/u);
  const version = await run(["--version"]);
  assert.equal(version.stdout, "0.1.1\n");
});
