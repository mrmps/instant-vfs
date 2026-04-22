// Compare two gitvfs-bench runs.jsonl files (or two git revisions of one).
//
// Intended loop:
//   1. bun bench/agents/bench.ts --note "before"
//   2. git add bench/agents/results && git commit -m "bench: baseline"
//   3. ship a gitvfs change
//   4. bun bench/agents/bench.ts --note "after AS-xxx"
//   5. bun bench/agents/diff.ts --before HEAD~1 --after HEAD
//
// You can also pass explicit jsonl paths:
//   bun bench/agents/diff.ts --before-file a.jsonl --after-file b.jsonl
//
// How "before" and "after" are picked from a single runs.jsonl:
//   - If both files are the same, we group by benchRunId and pick the two
//     most recent invocations (second-most-recent = before, most = after).
//   - If --before-run and --after-run are passed, we use those benchRunIds.
//   - If --before / --after are git revs, we `git show` the file at each rev.
//
// The diff is per-task × per-condition. Wall-clock, tool calls, cost deltas
// with paired before/after and a % change. Regressions (>5%) flagged with ⚠.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const RUNS_PATH = "bench/agents/results/runs.jsonl";

type RunSummary = {
  runId: string;
  benchRunId: string;
  ts: string;
  model: string;
  workerCommit: string;
  workerDirty: boolean;
  note: string | null;
  taskId: string;
  condition: "baseline" | "gitvfs";
  trial: number;
  category: string;
  passed: boolean;
  answer: string;
  toolCalls: number;
  iterations: number;
  wallClockMs: number;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  traceFile: string;
};

function parseJsonl(text: string): RunSummary[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RunSummary);
}

function loadFromGitRev(path: string, rev: string): RunSummary[] {
  try {
    const text = execSync(`git show ${rev}:${path}`, { encoding: "utf-8" });
    return parseJsonl(text);
  } catch (e: any) {
    console.error(`Could not read ${path} at ${rev}: ${e.message ?? e}`);
    process.exit(1);
  }
}

function loadLatest(rows: RunSummary[], which: "before" | "after", explicitId?: string): RunSummary[] {
  if (explicitId) {
    const subset = rows.filter((r) => r.benchRunId === explicitId);
    if (subset.length === 0) {
      console.error(`No rows with benchRunId=${explicitId} in runs.jsonl`);
      process.exit(1);
    }
    return subset;
  }
  // Group by benchRunId; pick two most recent.
  const byRun = new Map<string, RunSummary[]>();
  for (const r of rows) {
    const arr = byRun.get(r.benchRunId) ?? [];
    arr.push(r);
    byRun.set(r.benchRunId, arr);
  }
  const runIds = [...byRun.keys()].sort();
  if (runIds.length < 2) {
    console.error("Need at least 2 bench invocations in runs.jsonl to diff. Run bench twice first, or pass --before-file/--after-file.");
    process.exit(1);
  }
  const pickId = which === "before" ? runIds[runIds.length - 2] : runIds[runIds.length - 1];
  return byRun.get(pickId)!;
}

type Aggregate = {
  n: number;
  passRate: number;
  meanCalls: number;
  meanMs: number;
  meanInputTokens: number;
  meanCostUsd: number;
};

function aggregate(rows: RunSummary[]): Aggregate {
  if (rows.length === 0) {
    return { n: 0, passRate: 0, meanCalls: 0, meanMs: 0, meanInputTokens: 0, meanCostUsd: 0 };
  }
  const mean = (f: (r: RunSummary) => number) =>
    rows.reduce((s, r) => s + f(r), 0) / rows.length;
  return {
    n: rows.length,
    passRate: rows.filter((r) => r.passed).length / rows.length,
    meanCalls: mean((r) => r.toolCalls),
    meanMs: mean((r) => r.wallClockMs),
    meanInputTokens: mean((r) => r.inputTokens),
    meanCostUsd: mean((r) => r.costUsd),
  };
}

function pctDelta(a: number, b: number): string {
  if (a === 0) return b === 0 ? "0.0%" : "+∞";
  return `${((b - a) / a * 100).toFixed(1)}%`;
}

function flag(a: number, b: number, lowerIsBetter = true): string {
  if (a === 0) return "";
  const d = (b - a) / a;
  const regression = lowerIsBetter ? d > 0.05 : d < -0.05;
  const improvement = lowerIsBetter ? d < -0.05 : d > 0.05;
  if (regression) return " ⚠";
  if (improvement) return " ✅";
  return "";
}

function fmt(n: number, digits = 1): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function main() {
  const args = process.argv.slice(2);
  const argOf = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] ?? null : null;
  };

  const beforeFile = argOf("--before-file");
  const afterFile = argOf("--after-file");
  const beforeRev = argOf("--before");
  const afterRev = argOf("--after");
  const beforeRunId = argOf("--before-run");
  const afterRunId = argOf("--after-run");

  let beforeRows: RunSummary[];
  let afterRows: RunSummary[];

  if (beforeFile && afterFile) {
    beforeRows = parseJsonl(readFileSync(beforeFile, "utf-8"));
    afterRows = parseJsonl(readFileSync(afterFile, "utf-8"));
  } else if (beforeRev && afterRev) {
    beforeRows = loadFromGitRev(RUNS_PATH, beforeRev);
    afterRows = loadFromGitRev(RUNS_PATH, afterRev);
  } else {
    if (!existsSync(RUNS_PATH)) {
      console.error(`${RUNS_PATH} not found`);
      process.exit(1);
    }
    const all = parseJsonl(readFileSync(RUNS_PATH, "utf-8"));
    beforeRows = loadLatest(all, "before", beforeRunId ?? undefined);
    afterRows = loadLatest(all, "after", afterRunId ?? undefined);
  }

  const tag = (rows: RunSummary[]) =>
    `${rows[0]?.benchRunId ?? "?"} (worker ${rows[0]?.workerCommit?.slice(0, 7) ?? "?"}${rows[0]?.note ? `, ${rows[0].note}` : ""})`;

  const taskIds = [
    ...new Set([...beforeRows, ...afterRows].map((r) => r.taskId)),
  ].sort();

  let out = `# gitvfs-bench diff\n\n`;
  out += `**Before:** ${tag(beforeRows)}  \n`;
  out += `**After:**  ${tag(afterRows)}\n\n`;

  for (const condition of ["baseline", "gitvfs"] as const) {
    out += `## ${condition}\n\n`;
    const bAgg = aggregate(beforeRows.filter((r) => r.condition === condition));
    const aAgg = aggregate(afterRows.filter((r) => r.condition === condition));
    if (bAgg.n === 0 && aAgg.n === 0) {
      out += `_no rows for ${condition}_\n\n`;
      continue;
    }
    out += `### Aggregate\n\n`;
    out += `| Metric | Before | After | Δ |\n|---|---:|---:|---:|\n`;
    out += `| n | ${bAgg.n} | ${aAgg.n} | — |\n`;
    out += `| Pass rate | ${(bAgg.passRate * 100).toFixed(1)}% | ${(aAgg.passRate * 100).toFixed(1)}% | ${((aAgg.passRate - bAgg.passRate) * 100).toFixed(1)} pp |\n`;
    out += `| Mean tool calls | ${bAgg.meanCalls.toFixed(1)} | ${aAgg.meanCalls.toFixed(1)} | ${pctDelta(bAgg.meanCalls, aAgg.meanCalls)}${flag(bAgg.meanCalls, aAgg.meanCalls)} |\n`;
    out += `| Mean wall-clock (s) | ${(bAgg.meanMs/1000).toFixed(1)} | ${(aAgg.meanMs/1000).toFixed(1)} | ${pctDelta(bAgg.meanMs, aAgg.meanMs)}${flag(bAgg.meanMs, aAgg.meanMs)} |\n`;
    out += `| Mean input tokens | ${fmt(bAgg.meanInputTokens, 0)} | ${fmt(aAgg.meanInputTokens, 0)} | ${pctDelta(bAgg.meanInputTokens, aAgg.meanInputTokens)}${flag(bAgg.meanInputTokens, aAgg.meanInputTokens)} |\n`;
    out += `| Mean cost | $${bAgg.meanCostUsd.toFixed(4)} | $${aAgg.meanCostUsd.toFixed(4)} | ${pctDelta(bAgg.meanCostUsd, aAgg.meanCostUsd)}${flag(bAgg.meanCostUsd, aAgg.meanCostUsd)} |\n\n`;

    out += `### Per-task\n\n`;
    out += `| Task | Pass Δ | Calls | Wall-clock | Cost |\n`;
    out += `|---|:-:|---|---|---|\n`;
    for (const taskId of taskIds) {
      const bTaskAgg = aggregate(beforeRows.filter((r) => r.condition === condition && r.taskId === taskId));
      const aTaskAgg = aggregate(afterRows.filter((r) => r.condition === condition && r.taskId === taskId));
      if (bTaskAgg.n === 0 && aTaskAgg.n === 0) continue;
      const passCell = bTaskAgg.n === 0 || aTaskAgg.n === 0
        ? (bTaskAgg.n === 0 ? "new" : "gone")
        : bTaskAgg.passRate === aTaskAgg.passRate
          ? "—"
          : `${(bTaskAgg.passRate * 100).toFixed(0)} → ${(aTaskAgg.passRate * 100).toFixed(0)}`;
      const cellPair = (bv: number, av: number, lowerIsBetter = true) =>
        bTaskAgg.n === 0 || aTaskAgg.n === 0
          ? "—"
          : `${bv.toFixed(1)} → ${av.toFixed(1)} (${pctDelta(bv, av)}${flag(bv, av, lowerIsBetter)})`;
      out += `| ${taskId} | ${passCell} | ${cellPair(bTaskAgg.meanCalls, aTaskAgg.meanCalls)} | ${cellPair(bTaskAgg.meanMs, aTaskAgg.meanMs)} | ${cellPair(bTaskAgg.meanCostUsd, aTaskAgg.meanCostUsd)} |\n`;
    }
    out += `\n`;
  }

  console.log(out);
}

main();
