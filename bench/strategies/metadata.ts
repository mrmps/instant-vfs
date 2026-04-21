import { getTree, resolveSha, RateLimit, resetRunCounter } from "../lib/github.ts";
import { RssWatcher, type Metrics } from "../lib/metrics.ts";

export async function runMetadata(repo: string): Promise<Metrics> {
  const [owner, name] = repo.split("/");
  const rss = new RssWatcher();
  rss.start();
  const t0 = performance.now();

  let notes = "";
  let treeReadyMs: number | undefined;

  try {
    resetRunCounter();
    const sha = await resolveSha(owner, name);
    const { truncated, entries } = await getTree(owner, name, sha);
    treeReadyMs = performance.now() - t0;
    if (truncated) notes += "TREE TRUNCATED. ";

    const blobs = entries.filter((e) => e.type === "blob");

    return {
      strategy: "metadata",
      repo,
      ok: true,
      wallMs: performance.now() - t0,
      treeReadyMs,
      bytesIn: 0,
      bytesStored: 0,
      filesTotal: blobs.length,
      filesStored: 0,
      filesSkipped: 0,
      apiCalls: RateLimit.callsThisRun,
      peakRssMb: rss.stop() / 1024 / 1024,
      notes: notes.trim() || undefined,
    };
  } catch (e: any) {
    return {
      strategy: "metadata",
      repo,
      ok: false,
      error: e?.message ?? String(e),
      wallMs: performance.now() - t0,
      treeReadyMs,
      bytesIn: 0,
      bytesStored: 0,
      filesTotal: 0,
      filesStored: 0,
      filesSkipped: 0,
      apiCalls: RateLimit.callsThisRun,
      peakRssMb: rss.stop() / 1024 / 1024,
      notes: notes.trim() || undefined,
    };
  }
}
