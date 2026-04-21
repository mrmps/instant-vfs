import { getTree, resolveSha, RateLimit, resetRunCounter } from "../lib/github.ts";
import { shouldSkip } from "../lib/filter.ts";
import { RssWatcher, type Metrics } from "../lib/metrics.ts";

const CONCURRENCY = 64;

async function pLimit<T>(tasks: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= tasks.length) return;
      out[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return out;
}

export async function runTreesParallel(repo: string): Promise<Metrics> {
  const [owner, name] = repo.split("/");
  const rss = new RssWatcher();
  rss.start();
  const t0 = performance.now();
  resetRunCounter();

  let bytesIn = 0;
  let bytesStored = 0;
  let filesTotal = 0;
  let filesStored = 0;
  let filesSkipped = 0;
  let treeReadyMs: number | undefined;
  let notes = "";

  try {
    const sha = await resolveSha(owner, name);
    const { truncated, entries } = await getTree(owner, name, sha);
    treeReadyMs = performance.now() - t0;
    if (truncated) notes += "TREE TRUNCATED. ";

    const blobs = entries.filter((e) => e.type === "blob");
    filesTotal = blobs.length;

    const toFetch: typeof blobs = [];
    for (const b of blobs) {
      const skip = shouldSkip(b.path, b.size ?? 0);
      if (skip) {
        filesSkipped++;
        continue;
      }
      toFetch.push(b);
    }

    const tasks = toFetch.map((b) => async () => {
      const url = `https://raw.githubusercontent.com/${owner}/${name}/${sha}/${b.path}`;
      const r = await fetch(url, {
        headers: { "User-Agent": "gitvfs-bench/0.0.1" },
      });
      if (!r.ok) {
        filesSkipped++;
        return;
      }
      const buf = await r.arrayBuffer();
      bytesIn += buf.byteLength;
      bytesStored += buf.byteLength;
      filesStored++;
    });

    await pLimit(tasks, CONCURRENCY);

    return {
      strategy: "trees-parallel",
      repo,
      ok: true,
      wallMs: performance.now() - t0,
      treeReadyMs,
      bytesIn,
      bytesStored,
      filesTotal,
      filesStored,
      filesSkipped,
      apiCalls: RateLimit.callsThisRun,
      peakRssMb: rss.stop() / 1024 / 1024,
      notes: notes.trim() || undefined,
    };
  } catch (e: any) {
    return {
      strategy: "trees-parallel",
      repo,
      ok: false,
      error: e?.message ?? String(e),
      wallMs: performance.now() - t0,
      treeReadyMs,
      bytesIn,
      bytesStored,
      filesTotal,
      filesStored,
      filesSkipped,
      apiCalls: RateLimit.callsThisRun,
      peakRssMb: rss.stop() / 1024 / 1024,
      notes: notes.trim() || undefined,
    };
  }
}
