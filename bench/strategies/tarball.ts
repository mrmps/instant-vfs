import { gh, resolveSha, RateLimit, resetRunCounter } from "../lib/github.ts";
import { shouldSkip } from "../lib/filter.ts";
import { RssWatcher, type Metrics } from "../lib/metrics.ts";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tarStream from "tar-stream";

export async function runTarball(repo: string): Promise<Metrics> {
  const [owner, name] = repo.split("/");
  const rss = new RssWatcher();
  rss.start();
  const t0 = performance.now();

  let bytesIn = 0;
  let bytesStored = 0;
  let filesTotal = 0;
  let filesStored = 0;
  let filesSkipped = 0;
  let notes = "";
  let treeReadyMs: number | undefined;

  try {
    resetRunCounter();
    const sha = await resolveSha(owner, name);
    const url = `https://api.github.com/repos/${owner}/${name}/tarball/${sha}`;
    const res = await gh(url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`tarball: ${res.status}`);

    const extract = tarStream.extract();

    // Count raw (compressed) bytes as they arrive from the network.
    const counting = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        bytesIn += chunk.byteLength;
        ctrl.enqueue(chunk);
      },
    });
    const netStream = res.body.pipeThrough(counting);

    const nodeReadable = Readable.fromWeb(netStream as any);
    const gunzip = createGunzip();

    extract.on("entry", (header, stream, next) => {
      filesTotal++;
      // Strip top-level "owner-repo-sha/" prefix
      const slash = header.name.indexOf("/");
      const path = slash >= 0 ? header.name.slice(slash + 1) : header.name;

      if (header.type !== "file") {
        stream.resume();
        stream.on("end", next);
        return;
      }

      const size = header.size ?? 0;
      const skip = shouldSkip(path, size);
      if (skip) {
        filesSkipped++;
        stream.resume();
        stream.on("end", next);
        return;
      }

      // Capture bytes — this is the "stored" simulation (we'd PUT to R2 / insert row).
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const buf = Buffer.concat(chunks);
        bytesStored += buf.byteLength;
        filesStored++;
        next();
      });
      stream.on("error", next);
    });

    await pipeline(nodeReadable, gunzip, extract);

    treeReadyMs = performance.now() - t0; // in tarball mode tree is only known after full extract

    return {
      strategy: "tarball",
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
      strategy: "tarball",
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
