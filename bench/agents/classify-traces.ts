// Label every tool call in a bench run with classifier.dev, so the trace
// analysis is a histogram instead of a hand-written narrative.
//
//   bun bench/agents/classify-traces.ts <benchRunId> [<benchRunId> ...]
//   bun bench/agents/classify-traces.ts 2026-09-19T08-06-06-939
//
// classifier.dev takes up to 1,000 inputs per request and returns a label
// plus a calibrated confidence for each, with no key. We send one line per
// tool call (condition, position, URL, status, size) and read back the mix
// of call types per condition — "how did agents actually use the API?"

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LABELS = [
  "semantic query: /find, /ask, /locate, ?about= or ?intent=",
  "targeted read: /file with ?lines=, /symbol, /stat, or /outline of one file",
  "broad read: whole file, full /tree, or a large listing",
  "search: /grep, /bash grep, or GitHub search",
  "failed request: 4xx or 5xx status",
  "github.com or api.github.com fetch (non-gitvfs)",
];

type Call = { run: string; task: string; condition: string; i: number; n: number; url: string; status: number | null; bytes: number };

function loadCalls(runId: string): Call[] {
  const dir = join(import.meta.dir, "results", "traces");
  const out: Call[] = [];
  for (const f of readdirSync(dir).filter((f) => f.startsWith(runId) && f.endsWith(".jsonl"))) {
    const m = f.match(/-(T\d+)-(baseline|gitvfs)-\d+\.jsonl$/);
    if (!m) continue;
    const events = readFileSync(join(dir, f), "utf-8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.url);
    events.forEach((e, i) => out.push({ run: runId, task: m[1], condition: m[2], i: i + 1, n: events.length, url: e.url, status: e.status ?? null, bytes: e.bytes ?? 0 }));
  }
  return out;
}

function describe(c: Call): string {
  const u = new URL(c.url);
  return `condition=${c.condition} call ${c.i}/${c.n} status=${c.status ?? "network-error"} bytes=${c.bytes} host=${u.host} path=${u.pathname} query=${u.search.slice(0, 160)}`;
}

const runs = process.argv.slice(2);
if (!runs.length) { console.error("usage: classify-traces.ts <benchRunId>..."); process.exit(1); }
const calls = runs.flatMap(loadCalls);
if (!calls.length) { console.error("no traces found"); process.exit(1); }

const res = await fetch("https://classifier.dev", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ inputs: calls.map(describe), labels: LABELS }),
});
if (!res.ok) throw new Error(`classifier.dev ${res.status}: ${await res.text()}`);
const j = (await res.json()) as { results: Array<{ label: string; confidence: number }> };

const short = (l: string) => l.split(":")[0];
const byCond: Record<string, Record<string, number>> = {};
const unsure: Array<{ c: Call; label: string; confidence: number }> = [];
calls.forEach((c, i) => {
  const r = j.results[i];
  byCond[c.condition] ??= {};
  byCond[c.condition][short(r.label)] = (byCond[c.condition][short(r.label)] ?? 0) + 1;
  if (r.confidence < 0.6) unsure.push({ c, label: r.label, confidence: r.confidence });
});

const conds = Object.keys(byCond).sort();
console.log(`\nTool calls across ${runs.length} run(s): ${calls.length} calls, labeled by classifier.dev\n`);
console.log(`| Call type | ${conds.join(" | ")} |`);
console.log(`|---|${conds.map(() => "---:").join("|")}|`);
for (const l of LABELS.map(short)) {
  console.log(`| ${l} | ${conds.map((c) => byCond[c][l] ?? 0).join(" | ")} |`);
}
console.log(`| **total** | ${conds.map((c) => calls.filter((x) => x.condition === c).length).join(" | ")} |`);
const tasks = (c: string) => new Set(calls.filter((x) => x.condition === c).map((x) => x.run + x.task)).size;
console.log(`| calls per task | ${conds.map((c) => (calls.filter((x) => x.condition === c).length / tasks(c)).toFixed(2)).join(" | ")} |`);
if (unsure.length) {
  console.log(`\n${unsure.length} low-confidence labels (<0.6):`);
  for (const u of unsure.slice(0, 10)) console.log(`  ${u.confidence.toFixed(2)} ${short(u.label).padEnd(16)} ${u.c.condition} ${u.c.task} ${u.c.url.slice(0, 110)}`);
}
