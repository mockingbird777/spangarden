import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { InputLimitError, loadInput, parseInputText } from "../src/input.js";

test("parses a JSON document and JSONL records", () => {
  assert.deepEqual(parseInputText('{"spans":[]}'), { spans: [] });
  assert.deepEqual(parseInputText('{"id":1}\n\n{"id":2}\n'), [{ id: 1 }, { id: 2 }]);
});

test("reports the failing JSONL line", () => {
  assert.throws(() => parseInputText('{"id":1}\nnot-json'), /line 2/u);
});

test("loads gzip and enforces the decompressed boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "spangarden-input-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const small = join(directory, "small.json.gz");
  await writeFile(small, gzipSync('{"id":"one","name":"span"}'));
  assert.deepEqual(await loadInput(small, 1024), { id: "one", name: "span" });
  const bomb = join(directory, "large.json.gz");
  await writeFile(bomb, gzipSync(JSON.stringify({ value: "x".repeat(4_000) })));
  await assert.rejects(loadInput(bomb, 1024), InputLimitError);
});

test("rejects an oversized plain file before buffering", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "spangarden-bound-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "large.json");
  await writeFile(file, JSON.stringify({ value: "x".repeat(4_000) }));
  await assert.rejects(loadInput(file, 1024), InputLimitError);
});
