// End-to-end latency benchmark against a deployed gitvfs worker.
//
// Measures two user-visible call types per case:
//   · warm  — DO is hot; each request busts the edge cache, so it always
//             exercises the full Worker → DO → SQL path.
//   · edge  — same URL in a row; after a priming hit, subsequent requests
//             should be served from Cloudflare colo cache.
//
// Does NOT benchmark cold ingest (first-ever request for a SHA) — that's
// bounded by GitHub tarball fetch + Worker CPU and deserves its own harness.
// See bench/run.ts for the offline ingest-strategy benchmark.
//
// Usage:
//   bun bench/worker.ts                          # default: 15 iters, prod base
//   BENCH_ITERS=30 bun bench/worker.ts           # more samples
//   GITVFS_BASE=http://localhost:8787 bun bench/worker.ts
//   bun bench/worker.ts ky                       # filter cases by substring

const BASE = process.env.GITVFS_BASE ?? "https://gitvfs.miryaboy.workers.dev";
const ITERS = Number(process.env.BENCH_ITERS ?? 15);
const FILTER = process.argv[2]?.toLowerCase();

const SMALL_REPO = process.env.BENCH_SMALL ?? "sindresorhus/ky";
const MID_REPO = process.env.BENCH_MID ?? "tj/commander.js";
const BIG_REPO = process.env.BENCH_BIG ?? "facebook/react";

interface Case {
  name: string;
  repo: string;
  path: (repo: string) => string;
}

const CASES: Case[] = [
  // Small repo: the "agent lookup" hot paths.
  { name: "tree (small)",           repo: SMALL_REPO, path: (r) => `/${r}/tree` },
  { name: "tree.json (small)",      repo: SMALL_REPO, path: (r) => `/${r}/tree.json` },
  { name: "tree.json?outlines=1",   repo: SMALL_REPO, path: (r) => `/${r}/tree.json?outlines=1` },
  { name: "stat",                   repo: SMALL_REPO, path: (r) => `/${r}/stat/source/index.ts` },
  { name: "file (full)",            repo: SMALL_REPO, path: (r) => `/${r}/file/source/index.ts` },
  { name: "file?lines=1-20",        repo: SMALL_REPO, path: (r) => `/${r}/file/source/index.ts?lines=1-20` },
  { name: "outline",                repo: SMALL_REPO, path: (r) => `/${r}/outline/source/index.ts` },
  { name: "grep common",            repo: SMALL_REPO, path: (r) => `/${r}/grep?q=fetch&limit=50` },
  { name: "grep rare",              repo: SMALL_REPO, path: (r) => `/${r}/grep?q=__unlikely_token_xyz__&limit=50` },
  { name: "head (no DO)",           repo: SMALL_REPO, path: (r) => `/${r}/head` },

  // Medium repo.
  { name: "tree (medium)",          repo: MID_REPO,   path: (r) => `/${r}/tree` },
  { name: "grep (medium)",          repo: MID_REPO,   path: (r) => `/${r}/grep?q=option&limit=50` },

  // Big repo: what do things look like when the response payload is large?
  { name: "tree (big)",             repo: BIG_REPO,   path: (r) => `/${r}/tree` },
  { name: "tree.json (big)",        repo: BIG_REPO,   path: (r) => `/${r}/tree.json` },
  { name: "grep (big)",             repo: BIG_REPO,   path: (r) => `/${r}/grep?q=useEffect&limit=50` },
];

function bust(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}_cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

interface HitResult {
  ms: number;
  status: number;
  source: string | null; // x-gitvfs-source header ("edge" | "do" | null)
  bytes: number;
}

// If GITVFS_INTERNAL_KEY is in the env, send it so this benchmark isn't
// rate-limited by its own quotas. Required whenever the bench IP shares a
// quota with the service's normal per-IP limits.
const INTERNAL_KEY = process.env.GITVFS_INTERNAL_KEY;
const BYPASS_HEADERS: Record<string, string> = INTERNAL_KEY
  ? { "x-gitvfs-key": INTERNAL_KEY }
  : {};

async function hit(path: string): Promise<HitResult> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, { headers: BYPASS_HEADERS });
  const buf = await res.arrayBuffer();
  const ms = performance.now() - t0;
  return {
    ms,
    status: res.status,
    source: res.headers.get("x-gitvfs-source"),
    bytes: buf.byteLength,
  };
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

interface Summary {
  p50: number;
  p95: number;
  mean: number;
  min: number;
  max: number;
  meanBytes: number;
  ok: number;
  fail: number;
  edgeHits: number; // count of responses with x-gitvfs-source: edge
}

function summarize(hits: HitResult[]): Summary {
  const ok = hits.filter((h) => h.status === 200);
  const times = ok.map((h) => h.ms);
  const bytes = ok.map((h) => h.bytes);
  const edgeHits = ok.filter((h) => h.source === "edge").length;
  return {
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    mean: times.length ? times.reduce((a, b) => a + b, 0) / times.length : NaN,
    min: times.length ? Math.min(...times) : NaN,
    max: times.length ? Math.max(...times) : NaN,
    meanBytes: bytes.length ? bytes.reduce((a, b) => a + b, 0) / bytes.length : 0,
    ok: ok.length,
    fail: hits.length - ok.length,
    edgeHits,
  };
}

interface CaseResult {
  name: string;
  repo: string;
  iters: number;
  warm: Summary;
  edge: Summary;
}

async function runCase(c: Case): Promise<CaseResult> {
  // Prime the DO so the first timed request isn't a cold ingest.
  // Uses ?refresh=1 path-agnostically (for /head) or a busted URL otherwise.
  await hit(bust(c.path(c.repo))).catch(() => ({ ms: 0, status: 0, source: null, bytes: 0 }));

  // Warm: bust the edge cache every call so we measure the DO path.
  const warmHits: HitResult[] = [];
  for (let i = 0; i < ITERS; i++) {
    warmHits.push(await hit(bust(c.path(c.repo))));
  }

  // Edge: same URL every call. First hit primes edge cache; subsequent should be cache hits.
  const edgeUrl = c.path(c.repo);
  await hit(edgeUrl); // prime
  const edgeHits: HitResult[] = [];
  for (let i = 0; i < ITERS; i++) {
    edgeHits.push(await hit(edgeUrl));
  }

  return {
    name: c.name,
    repo: c.repo,
    iters: ITERS,
    warm: summarize(warmHits),
    edge: summarize(edgeHits),
  };
}

function ms(n: number): string {
  if (!Number.isFinite(n)) return "-".padStart(5);
  return `${Math.round(n)}`.padStart(4) + "ms";
}

function kb(b: number): string {
  if (b < 1024) return `${Math.round(b)}B`;
  return `${(b / 1024).toFixed(1)}KB`;
}

async function main() {
  console.log(`base: ${BASE}`);
  console.log(`iters per (case × type): ${ITERS}`);
  if (FILTER) console.log(`filter: ${FILTER}`);
  console.log("");

  const cases = FILTER
    ? CASES.filter((c) => c.name.toLowerCase().includes(FILTER) || c.repo.toLowerCase().includes(FILTER))
    : CASES;

  if (cases.length === 0) {
    console.error(`No cases match filter "${FILTER}".`);
    process.exit(1);
  }

  const header = `${"case".padEnd(28)} ${"repo".padEnd(22)} ${"warm p50".padStart(8)} ${"p95".padStart(6)} ${"edge p50".padStart(9)} ${"p95".padStart(6)} ${"bytes".padStart(8)}  edgeHit/iters`;
  console.log(header);
  console.log("-".repeat(header.length));

  const results: CaseResult[] = [];
  for (const c of cases) {
    const r = await runCase(c);
    results.push(r);
    const edgeRate = `${r.edge.edgeHits}/${ITERS}`;
    console.log(
      `${c.name.padEnd(28)} ${c.repo.padEnd(22)} ${ms(r.warm.p50)} ${ms(r.warm.p95)}  ${ms(r.edge.p50)} ${ms(r.edge.p95)}  ${kb(r.warm.meanBytes).padStart(8)}  ${edgeRate}${r.warm.fail || r.edge.fail ? `  ⚠ fail=${r.warm.fail + r.edge.fail}` : ""}`,
    );
  }

  const outPath = `bench/results/worker-${Date.now()}.json`;
  await Bun.write(
    outPath,
    JSON.stringify(
      { base: BASE, iters: ITERS, ranAt: new Date().toISOString(), results },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${outPath}`);

  // Fail the process if any case had a non-200 — useful in CI.
  const anyFail = results.some((r) => r.warm.fail > 0 || r.edge.fail > 0);
  if (anyFail) process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
