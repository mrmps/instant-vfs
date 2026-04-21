import { runTreesParallel } from "./strategies/trees-parallel.ts";
import { runTarball } from "./strategies/tarball.ts";
import { runMetadata } from "./strategies/metadata.ts";
import { mb, type Metrics } from "./lib/metrics.ts";
import { RateLimit } from "./lib/github.ts";

const REPOS = [
  "sindresorhus/ky",
  "facebook/react",
  "vercel/next.js",
];

const STRATEGIES = [
  { name: "metadata", fn: runMetadata },
  { name: "trees-parallel", fn: runTreesParallel },
  { name: "tarball", fn: runTarball },
];

function fmt(m: Metrics): string {
  if (!m.ok) return `  ✗ ${m.strategy.padEnd(16)} FAIL in ${m.wallMs.toFixed(0)}ms: ${m.error}`;
  const wall = `${(m.wallMs / 1000).toFixed(2)}s`.padStart(7);
  const tr = m.treeReadyMs != null ? `${(m.treeReadyMs / 1000).toFixed(2)}s` : "-";
  return `  ✓ ${m.strategy.padEnd(16)} wall=${wall}  tree=${tr.padStart(6)}  bytesIn=${mb(m.bytesIn)}MB  stored=${mb(m.bytesStored)}MB  files=${m.filesStored}/${m.filesTotal} (${m.filesSkipped} skipped)  api=${m.apiCalls}  rss=${m.peakRssMb.toFixed(0)}MB${m.notes ? "  ⚠ " + m.notes : ""}`;
}

async function main() {
  const results: Metrics[] = [];
  const filter = process.argv[2]; // optional repo filter

  for (const repo of REPOS) {
    if (filter && !repo.includes(filter)) continue;
    console.log(`\n=== ${repo} ===`);
    for (const s of STRATEGIES) {
      process.stdout.write(`  ${s.name}... `);
      const m = await s.fn(repo);
      console.log();
      console.log(fmt(m));
      results.push(m);
      console.log(`     rate-limit remaining: ${RateLimit.remaining}`);
      // tiny breather to be polite
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log("\n\n=== Summary ===");
  console.table(
    results.map((m) => ({
      repo: m.repo,
      strategy: m.strategy,
      ok: m.ok,
      "wall (s)": m.ok ? (m.wallMs / 1000).toFixed(2) : "-",
      "tree (s)": m.treeReadyMs != null ? (m.treeReadyMs / 1000).toFixed(2) : "-",
      "bytesIn MB": mb(m.bytesIn),
      "stored MB": mb(m.bytesStored),
      files: m.filesStored,
      total: m.filesTotal,
      api: m.apiCalls,
      "rss MB": m.peakRssMb.toFixed(0),
      notes: m.notes ?? "",
    })),
  );

  await Bun.write(
    `bench/results/run-${Date.now()}.json`,
    JSON.stringify(results, null, 2),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
