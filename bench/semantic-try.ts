// Iterate on the semantic layer locally against the deployed lexical API.
//
//   TYPESAFE_API_KEY=... bun bench/semantic-try.ts find honojs/hono@<sha> "where is bodyLimit?"
//   bun bench/semantic-try.ts tasks            # run every bench task through /find
//   bun bench/semantic-try.ts locate <repo> <path> "<q>"
//   bun bench/semantic-try.ts rerank <repo> "<grep pattern>" "<intent>"
//
// Reads .env for TYPESAFE_API_KEY + GITVFS_INTERNAL_KEY.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { find, locate, rerank, roles, type Source } from "../src/semantic";
import { JevMeter } from "../src/jev";

for (const line of (() => { try { return readFileSync(join(import.meta.dir, "..", ".env"), "utf-8").split("\n"); } catch { return []; } })()) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const KEY = process.env.TYPESAFE_API_KEY!;
if (!KEY) throw new Error("TYPESAFE_API_KEY missing");
const BASE = process.env.GITVFS_BASE ?? "https://gitvfs.miryaboy.workers.dev";
const INTERNAL = process.env.GITVFS_INTERNAL_KEY;

function http(repo: string): Source {
  const h: Record<string, string> = INTERNAL ? { "x-gitvfs-key": INTERNAL } : {};
  const get = async (p: string) => {
    const r = await fetch(`${BASE}/${repo}${p}`, { headers: h });
    if (!r.ok) throw new Error(`${p} → ${r.status} ${await r.text()}`);
    return r;
  };
  return {
    async paths() { return (await (await get("/tree")).text()).trim().split("\n").filter(Boolean); },
    async level(prefix) {
      const j = await (await get(`/tree.json${prefix ? "/" + prefix : ""}?depth=1`)).json() as any;
      return j.entries.map((e: any) => ({ path: e.path, kind: e.kind }));
    },
    async read(path) {
      const r = await fetch(`${BASE}/${repo}/file/${path}`, { headers: h });
      return r.ok ? r.text() : null;
    },
    async grep(o) {
      const u = new URLSearchParams({ q: o.q });
      if (o.regex) u.set("regex", "1");
      if (o.caseInsensitive) u.set("case", "i");
      if (o.word) u.set("word", "1");
      if (o.filesOnly) u.set("files_only", "1");
      if (o.limit) u.set("limit", String(o.limit));
      if (o.context) u.set("context", String(o.context));
      if (o.glob) u.set("glob", o.glob);
      const j = await (await get(`/grep?${u}`)).json() as any;
      return { files: j.files, matches: j.matches ?? [] };
    },
  };
}

const [cmd, ...args] = process.argv.slice(2);
const meter = new JevMeter();
const t0 = Date.now();

if (cmd === "find") {
  const [repo, q] = args;
  const r = await find(http(repo), { apiKey: KEY, meter }, q, { read: args.includes("--read") });
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === "locate") {
  const [repo, path, q] = args;
  const text = await http(repo).read(path);
  if (text === null) throw new Error("no such file");
  console.log(JSON.stringify(await locate({ apiKey: KEY, meter }, path, text, q), null, 2));
} else if (cmd === "rerank") {
  const [repo, pat, intent] = args;
  const g = await http(repo).grep({ q: pat, caseInsensitive: true, context: 2, limit: 120 });
  const r = await rerank({ apiKey: KEY, meter }, intent, g.matches);
  for (const m of r.slice(0, 10)) console.log(m.relevance.toFixed(2), `${m.path}:${m.line}`, m.text.trim().slice(0, 90));
} else if (cmd === "roles") {
  const [repo, prefix = ""] = args;
  const entries = await http(repo).level(prefix);
  const r = await roles({ apiKey: KEY, meter }, entries);
  for (const e of entries) { const x = r.get(e.path); console.log((x?.role ?? "?").padEnd(11), (x?.confidence ?? 0).toFixed(2), e.path + (e.kind === "dir" ? "/" : "")); }
} else if (cmd === "tasks") {
  const tasks = readFileSync(join(import.meta.dir, "agents", "tasks.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  for (const t of tasks) {
    const m = new JevMeter();
    const s = Date.now();
    try {
      const r = await find(http(`${t.repo}@${t.ref}`), { apiKey: KEY, meter: m }, t.question);
      const top = r.hits[0];
      console.log(`${t.id} ${t.category.padEnd(18)} ${Date.now() - s}ms jev=${m.requests}req/${m.inputTokens}tok exists=${r.exists} conf=${r.confidence}`);
      console.log(`    expected: ${JSON.stringify(t.expected).slice(0, 100)}`);
      for (const h of r.hits.slice(0, 3)) console.log(`    ${h.probability.toFixed(2)} ${h.kind.padEnd(6)} ${h.path}${h.line ? ":" + h.line : ""}${h.symbol ? " " + h.symbol : ""}${h.kind === "match" ? "  " + (h.snippet ?? "").slice(0, 80) : ""}`);
    } catch (e: any) {
      console.log(`${t.id} ERROR ${e?.message ?? e}`);
    }
  }
} else {
  console.log("usage: find|locate|rerank|roles|tasks");
}
console.error(`\n[${Date.now() - t0}ms, jev requests=${meter.requests}, tokens=${meter.inputTokens}, jev ms=${Math.round(meter.ms)}]`);
