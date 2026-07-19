import type { AnalysisReport, NormalizedSpan, OutputFormat, UsageRow } from "./types.js";

function duration(value: number): string {
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

function dollars(value: number): string {
  return value < 0.01 ? `$${value.toFixed(6)}` : `$${value.toFixed(4)}`;
}

function terminal(report: AnalysisReport): string {
  const summary = report.summary;
  const lines = [
    "",
    `  SPANGARDEN  ${report.title}`,
    "  " + "─".repeat(62),
    `  ${summary.traces} traces   ${summary.spans} spans   ${summary.errors} errors   ${summary.retries} retry candidates`,
    `  ${duration(summary.totalDurationMs)} wall time   p50 ${duration(summary.p50SpanMs)}   p95 ${duration(summary.p95SpanMs)}`,
    `  ${summary.inputTokens.toLocaleString("en-US")} in / ${summary.outputTokens.toLocaleString("en-US")} out tokens`,
  ];
  if (report.cost !== undefined) lines.push(`  ${dollars(report.cost.estimatedUsd)} estimated from local pricing (${report.cost.unpricedTokens.toLocaleString("en-US")} unpriced tokens)`);
  lines.push("", "  CRITICAL PATHS");
  const byId = new Map(report.spans.map((span) => [span.id, span]));
  for (const trace of report.traces) {
    const names = trace.criticalPath.map((id) => byId.get(id)?.name ?? id).join("  →  ");
    lines.push(`  ${trace.id}  ${duration(trace.criticalPathMs)}  ${names}`);
  }
  lines.push("", "  USAGE");
  if (report.usage.length === 0) lines.push("  No model or tool usage identified.");
  for (const row of report.usage) {
    const cost = row.estimatedCostUsd === undefined ? "" : `  ${dollars(row.estimatedCostUsd)}`;
    lines.push(`  ${row.type.padEnd(5)}  ${row.name.padEnd(24).slice(0, 24)}  ${String(row.calls).padStart(3)} calls  ${duration(row.durationMs).padStart(8)}  ${row.errors} err${cost}`);
  }
  if (report.loops.length > 0) {
    lines.push("", "  LOOP SIGNALS");
    for (const loop of report.loops.slice(0, 10)) lines.push(`  ${loop.reason}  ${loop.signature}  [${loop.spanIds.join(" → ")}]`);
  }
  if (report.warnings.length > 0) {
    lines.push("", "  NOTES");
    for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  }
  lines.push("", `  Redaction: ${report.redacted ? "on" : "OFF"} · No trace data left this machine.`, "");
  return lines.join("\n");
}

function markdownCell(value: string | number): string {
  return String(value).replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, " ");
}

function markdownUsage(row: UsageRow): string {
  const cost = row.estimatedCostUsd === undefined ? "—" : dollars(row.estimatedCostUsd);
  return `| ${markdownCell(row.type)} | ${markdownCell(row.name)} | ${row.calls} | ${row.errors} | ${duration(row.durationMs)} | ${row.inputTokens.toLocaleString("en-US")} | ${row.outputTokens.toLocaleString("en-US")} | ${cost} |`;
}

function markdown(report: AnalysisReport): string {
  const s = report.summary;
  const byId = new Map(report.spans.map((span) => [span.id, span]));
  const lines = [
    `# ${report.title.replace(/[\r\n]+/gu, " ")}`,
    "",
    "> Generated locally by SpanGarden. Sensitive-looking fields were " + (report.redacted ? "redacted." : "**not redacted**."),
    "",
    "## Overview",
    "",
    `- **${s.traces}** traces and **${s.spans}** spans`,
    `- **${s.errors}** errors, **${s.retries}** retry candidates, **${s.loops}** loop signals`,
    `- **${duration(s.totalDurationMs)}** total wall time; p50 **${duration(s.p50SpanMs)}**, p95 **${duration(s.p95SpanMs)}**`,
    `- **${s.inputTokens.toLocaleString("en-US")}** input and **${s.outputTokens.toLocaleString("en-US")}** output tokens`,
  ];
  if (report.cost !== undefined) lines.push(`- **${dollars(report.cost.estimatedUsd)}** estimated from the supplied local pricing file`);
  lines.push("", "## Critical paths", "");
  for (const trace of report.traces) lines.push(`- \`${markdownCell(trace.id)}\` · ${duration(trace.criticalPathMs)} · ${trace.criticalPath.map((id) => markdownCell(byId.get(id)?.name ?? id)).join(" → ")}`);
  lines.push("", "## Model and tool usage", "", "| Type | Name | Calls | Errors | Duration | Input tokens | Output tokens | Est. cost |", "|---|---|---:|---:|---:|---:|---:|---:|");
  if (report.usage.length === 0) lines.push("| — | No usage identified | 0 | 0 | 0ms | 0 | 0 | — |");
  else lines.push(...report.usage.map(markdownUsage));
  if (report.loops.length > 0) {
    lines.push("", "## Loop signals", "");
    for (const loop of report.loops) lines.push(`- **${loop.reason}:** \`${markdownCell(loop.signature)}\` — ${loop.spanIds.map((id) => `\`${markdownCell(id)}\``).join(" → ")}`);
  }
  if (report.warnings.length > 0) lines.push("", "## Notes", "", ...report.warnings.map((warning) => `- ${markdownCell(warning)}`));
  lines.push("");
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

function html(report: AnalysisReport): string {
  const encoded = Buffer.from(JSON.stringify(report), "utf8").toString("base64");
  const title = escapeHtml(report.title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
  <title>${title} · SpanGarden</title>
  <style>
    :root{--ink:#eaf4ed;--muted:#91a999;--panel:#111b17;--panel2:#17241e;--line:#2a3d32;--mint:#82f6b3;--lime:#cbf36b;--amber:#ffc66d;--rose:#ff7890;--cyan:#72d8ee;--shadow:0 24px 80px #0008}*{box-sizing:border-box}html{background:#07100c;color:var(--ink);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;background:radial-gradient(circle at 12% -10%,#204b33 0,transparent 38rem),radial-gradient(circle at 92% 8%,#143a3b 0,transparent 34rem),#07100c;min-height:100vh}.shell{width:min(1180px,calc(100% - 32px));margin:auto;padding:50px 0 72px}.eyebrow{display:flex;align-items:center;gap:10px;color:var(--mint);font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.seed{width:11px;height:11px;border-radius:50% 50% 50% 2px;transform:rotate(-35deg);background:linear-gradient(145deg,var(--lime),var(--mint));box-shadow:0 0 24px #82f6b388}h1{font-size:clamp(34px,6vw,64px);line-height:1.02;letter-spacing:-.045em;margin:18px 0 12px;max-width:900px}.subtitle{color:var(--muted);font-size:16px;max-width:700px;margin:0}.meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}.chip{padding:7px 11px;border:1px solid var(--line);border-radius:99px;background:#0c1712aa;color:#b7c9bd;font-size:12px}.cards{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin:34px 0}.card{position:relative;overflow:hidden;background:linear-gradient(150deg,#16251e,#0e1814);border:1px solid var(--line);border-radius:17px;padding:18px;box-shadow:0 12px 32px #0004}.card:after{content:"";position:absolute;inset:auto -20px -40px auto;width:80px;height:80px;border-radius:50%;background:var(--accent,var(--mint));filter:blur(36px);opacity:.16}.label{color:var(--muted);font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.1em}.value{font-size:27px;font-weight:780;letter-spacing:-.04em;margin-top:5px}.panel{background:#0d1713dd;border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow);margin-top:18px;overflow:hidden;backdrop-filter:blur(12px)}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 20px;border-bottom:1px solid var(--line)}h2{font-size:15px;letter-spacing:-.01em;margin:0}.controls{display:flex;gap:9px;flex-wrap:wrap}input,select{appearance:none;background:#08110d;color:var(--ink);border:1px solid #345040;border-radius:10px;padding:9px 11px;outline:none}input{width:230px}input:focus,select:focus{border-color:var(--mint);box-shadow:0 0 0 3px #82f6b318}.trace{border-bottom:1px solid #203027}.trace:last-child{border:0}.trace-title{display:flex;justify-content:space-between;gap:15px;padding:14px 20px;background:#111d18;color:#cfe1d5}.trace-id{font:700 12px ui-monospace,SFMono-Regular,Menlo,monospace}.span{display:grid;grid-template-columns:minmax(220px,1.2fr) 110px minmax(150px,1fr) 78px;gap:14px;align-items:center;padding:11px 20px;border-top:1px solid #192820}.span:hover{background:#14221b}.span-name{min-width:0;display:flex;align-items:center;gap:8px}.span-name strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dot{width:8px;height:8px;border-radius:50%;background:var(--kind,#91a999);box-shadow:0 0 12px color-mix(in srgb,var(--kind) 60%,transparent);flex:0 0 auto}.kind{font-size:11px;color:var(--muted);text-transform:uppercase}.track{height:8px;border-radius:99px;background:#1f3128;overflow:hidden}.bar{height:100%;min-width:3px;border-radius:inherit;background:linear-gradient(90deg,var(--kind),color-mix(in srgb,var(--kind) 55%,white));opacity:.82}.critical .bar{box-shadow:0 0 12px var(--lime);background:linear-gradient(90deg,var(--lime),var(--mint))}.bad{color:var(--rose)}.time{text-align:right;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#b8cbbf}.empty{padding:40px 20px;text-align:center;color:var(--muted)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px 18px;border-bottom:1px solid #1e3027}th{color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}tbody tr:last-child td{border:0}tbody tr:hover{background:#132119}.badge{display:inline-flex;padding:3px 7px;border-radius:6px;background:#1a2b22;color:var(--mint);font-size:11px;text-transform:uppercase}.loops{padding:4px 20px 16px}.loop{padding:12px 0;border-bottom:1px solid #203027}.loop:last-child{border:0}.loop code{color:var(--amber)}.note{color:var(--muted);font-size:12px}.footer{display:flex;justify-content:space-between;gap:20px;color:#678071;padding:24px 4px 0;font-size:12px}.footer strong{color:#9eb5a6}@media(max-width:900px){.cards{grid-template-columns:repeat(3,1fr)}.span{grid-template-columns:minmax(180px,1fr) 85px 1fr}.span .time{display:none}}@media(max-width:600px){.shell{width:min(100% - 20px,1180px);padding-top:28px}.cards{grid-template-columns:repeat(2,1fr)}.panel-head{align-items:flex-start;flex-direction:column}input{width:100%}.controls{width:100%;display:grid;grid-template-columns:1fr 110px}.span{grid-template-columns:1fr 72px;padding:11px 13px}.span .track,.span .time{display:none}th,td{padding:10px 12px}.hide-mobile{display:none}}
  </style>
</head>
<body>
  <main class="shell">
    <div class="eyebrow"><span class="seed"></span> SpanGarden · local agent observability</div>
    <h1>${title}</h1>
    <p class="subtitle">Follow the critical path, spot retry loops, and understand model and tool behavior—without sending a trace to the cloud.</p>
    <div class="meta" id="meta"></div>
    <section class="cards" id="cards"></section>
    <section class="panel">
      <div class="panel-head"><h2>Trace explorer</h2><div class="controls"><input id="search" type="search" placeholder="Filter spans…" autocomplete="off"><select id="kind"><option value="">All kinds</option><option>agent</option><option>model</option><option>tool</option><option>retrieval</option><option>other</option></select></div></div>
      <div id="traces"></div>
    </section>
    <section class="panel"><div class="panel-head"><h2>Model &amp; tool usage</h2><span class="note">Cost appears only when local pricing was supplied</span></div><div style="overflow:auto"><table><thead><tr><th>Type</th><th>Name</th><th class="num">Calls</th><th class="num">Errors</th><th class="num hide-mobile">Duration</th><th class="num hide-mobile">Tokens</th><th class="num">Est. cost</th></tr></thead><tbody id="usage"></tbody></table></div></section>
    <section class="panel" id="loop-panel"><div class="panel-head"><h2>Loop signals</h2><span class="note">Heuristics are evidence, not a verdict</span></div><div class="loops" id="loops"></div></section>
    <footer class="footer"><span><strong>SpanGarden</strong> · offline, deterministic, dependency-light</span><span id="footer-meta"></span></footer>
  </main>
  <script>
  "use strict";
  const report=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob("${encoded}"),function(c){return c.charCodeAt(0)})));
  const byId=new Map(report.spans.map(function(s){return [s.id,s]}));
  const kindColor={agent:"#82f6b3",model:"#72d8ee",tool:"#ffc66d",retrieval:"#cbf36b",other:"#91a999"};
  function node(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n}
  function dur(ms){return ms>=60000?(ms/60000).toFixed(1)+"m":ms>=1000?(ms/1000).toFixed(2)+"s":Math.round(ms)+"ms"}
  function money(v){return v<.01?"$"+v.toFixed(6):"$"+v.toFixed(4)}
  function chip(text){document.getElementById("meta").append(node("span","chip",text))}
  chip(report.summary.traces+" traces");chip(report.redacted?"redaction on":"redaction OFF");chip("source · "+report.source);chip("schema "+report.schemaVersion);
  const metrics=[["Spans",report.summary.spans,"#82f6b3"],["Errors",report.summary.errors,"#ff7890"],["Retry hints",report.summary.retries,"#ffc66d"],["Wall time",dur(report.summary.totalDurationMs),"#72d8ee"],["Tokens",(report.summary.inputTokens+report.summary.outputTokens).toLocaleString(),"#cbf36b"],[report.cost?"Est. cost":"p95 span",report.cost?money(report.cost.estimatedUsd):dur(report.summary.p95SpanMs),"#b89aff"]];
  metrics.forEach(function(m){const c=node("div","card");c.style.setProperty("--accent",m[2]);c.append(node("div","label",m[0]),node("div","value",m[1]));document.getElementById("cards").append(c)});
  const critical=new Set(report.traces.flatMap(function(t){return t.criticalPath}));
  function depth(span){let d=0,p=span.parentId,seen=new Set();while(p&&byId.has(p)&&!seen.has(p)&&d<12){seen.add(p);d++;p=byId.get(p).parentId}return d}
  function renderTraces(){const host=document.getElementById("traces");host.replaceChildren();const query=document.getElementById("search").value.toLowerCase();const selected=document.getElementById("kind").value;let shown=0;report.traces.forEach(function(trace){const spans=trace.spanIds.map(function(id){return byId.get(id)}).filter(Boolean).filter(function(s){return(!selected||s.kind===selected)&&(!query||(s.name+" "+s.model+" "+s.tool+" "+s.id).toLowerCase().includes(query))});if(!spans.length)return;shown+=spans.length;const section=node("section","trace");const head=node("div","trace-title");head.append(node("span","trace-id",trace.id),node("span","note",spans.length+" spans · critical "+dur(trace.criticalPathMs)));section.append(head);spans.forEach(function(s){const row=node("div","span"+(critical.has(s.id)?" critical":""));row.style.setProperty("--kind",kindColor[s.kind]||kindColor.other);const name=node("div","span-name");name.style.paddingLeft=Math.min(depth(s),8)*14+"px";name.append(node("span","dot"));const text=node("strong","",s.name);if(s.status==="error")text.classList.add("bad");name.append(text);const k=node("span","kind",s.kind);const track=node("div","track");const bar=node("div","bar");const width=trace.durationMs?Math.max(1,Math.min(100,s.durationMs/trace.durationMs*100)):1;bar.style.width=width+"%";track.append(bar);row.append(name,k,track,node("span","time",dur(s.durationMs)));section.append(row)});host.append(section)});if(!shown)host.append(node("div","empty","No spans match this filter."))}
  document.getElementById("search").addEventListener("input",renderTraces);document.getElementById("kind").addEventListener("change",renderTraces);renderTraces();
  const usage=document.getElementById("usage");report.usage.forEach(function(u){const tr=node("tr");const type=node("td");type.append(node("span","badge",u.type));tr.append(type,node("td","",u.name),node("td","num",u.calls),node("td","num"+(u.errors?" bad":""),u.errors),node("td","num hide-mobile",dur(u.durationMs)),node("td","num hide-mobile",(u.inputTokens+u.outputTokens).toLocaleString()),node("td","num",u.estimatedCostUsd===undefined?"—":money(u.estimatedCostUsd)));usage.append(tr)});if(!report.usage.length){const tr=node("tr");const td=node("td","empty","No model or tool usage identified.");td.colSpan=7;tr.append(td);usage.append(tr)}
  const loops=document.getElementById("loops");if(!report.loops.length){document.getElementById("loop-panel").hidden=true}else{report.loops.forEach(function(l){const item=node("div","loop");const code=node("code","",l.signature);item.append(code,node("span","note"," · "+l.reason+" · "+l.spanIds.join(" → ")));loops.append(item)})}
  document.getElementById("footer-meta").textContent="trace time · "+report.generatedAt.slice(0,10);
  </script>
</body>
</html>`;
}

export function formatReport(report: AnalysisReport, format: OutputFormat): string {
  switch (format) {
    case "terminal": return terminal(report);
    case "json": return JSON.stringify(report, null, 2) + "\n";
    case "markdown": return markdown(report);
    case "html": return html(report);
  }
}

export function spanLabel(span: NormalizedSpan): string {
  return span.tool ?? span.model ?? span.name;
}
