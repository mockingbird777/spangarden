import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSpans } from "../src/analyze.js";
import { formatReport } from "../src/format.js";
import { span } from "./helpers.js";

test("renders terminal, JSON, and Markdown reports", () => {
  const report = analyzeSpans([span("root", { kind: "model", model: "alpha", inputTokens: 5 })], { title: "Example | report" });
  assert.match(formatReport(report, "terminal"), /SPANGARDEN/u);
  assert.deepEqual(JSON.parse(formatReport(report, "json")), report);
  const md = formatReport(report, "markdown");
  assert.match(md, /# Example \\\| report/u);
  assert.match(md, /Model and tool usage/u);
});

test("embeds HTML data without exposing script-closing input", () => {
  const payload = '</script><img src=x onerror="alert(1)">';
  const report = analyzeSpans([span("x", { name: payload })], { title: payload, redact: false });
  const output = formatReport(report, "html");
  assert.ok(!output.includes(payload));
  assert.match(output, /Content-Security-Policy/u);
  assert.match(output, /Trace explorer/u);
  assert.match(output, /atob\("[A-Za-z0-9+/=]+"\)/u);
});

test("HTML is self-contained while providing an explicit repository link", () => {
  const output = formatReport(analyzeSpans([span("one")]), "html");
  assert.ok(!/<script\s+[^>]*src=["']https?:\/\//u.test(output));
  assert.ok(!/<link\s+[^>]*href=["']https?:\/\//u.test(output));
  assert.ok(!/<img\s+[^>]*src=["']https?:\/\//u.test(output));
  assert.match(output, /href="https:\/\/github\.com\/mockingbird777\/spangarden"/u);
  assert.match(output, /base-uri 'none'/u);
  assert.match(output, /name="referrer" content="no-referrer"/u);
});

test("neutralizes terminal controls and Markdown/HTML syntax from trace text", () => {
  const payload = '<img src=x onerror="alert(1)"> [click](javascript:alert(1))\u001b]0;owned';
  const report = analyzeSpans([span("x", { name: `line one\n${payload}`, kind: "model", model: payload })], { title: payload, redact: false });
  const terminal = formatReport(report, "terminal");
  assert.ok(!terminal.includes("\u001b"));
  assert.ok(!terminal.includes("line one\n<img"));
  const markdown = formatReport(report, "markdown");
  assert.ok(!markdown.includes("<img"));
  assert.match(markdown, /&lt;img/u);
  assert.ok(!markdown.includes("](javascript:"));
  assert.deepEqual(JSON.parse(formatReport(report, "json")), report);
});
