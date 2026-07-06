# gitvfs-bench

Paired agent evaluation for gitvfs. Runs the same LLM on the same task twice
— once with a system prompt that knows only about `github.com`, once with a
prompt that knows about `gitvfs.miryaboy.workers.dev` — and measures the
difference in correctness, tool calls, wall-clock, tokens, and cost.

Designed so that every bench run accumulates to a git-tracked history: when
we ship a gitvfs change, we can `git log` / `git diff` `results/runs.jsonl`
to see which commit moved which number, and pull full trace files to
understand why.

## Layout

```
bench/agents/
├── bench.ts                    # the runner
├── diff.ts                     # compare two bench runs
├── tasks.jsonl                 # 10 citation-style tasks pinned to SHAs
├── README.md
└── results/
    ├── runs.jsonl              # append-only: one line per (task×cond×trial)
    ├── <benchRunId>-report.md  # human-readable snapshot per invocation
    └── traces/
        └── <runId>.jsonl       # per-tool-call URL+status+headers+body
```

Everything under `results/` is committed intentionally — the history is the
point.

## Running

```bash
ANTHROPIC_API_KEY=sk-ant-... bun bench/agents/bench.ts
ANTHROPIC_API_KEY=sk-ant-... bun bench/agents/bench.ts --task T03
ANTHROPIC_API_KEY=sk-ant-... bun bench/agents/bench.ts --trials 3
ANTHROPIC_API_KEY=sk-ant-... bun bench/agents/bench.ts --note "after AS-004"
ANTHROPIC_API_KEY=sk-ant-... bun bench/agents/bench.ts --condition gitvfs
```

Every invocation gets a fresh `benchRunId` (ISO timestamp) and appends all
its rows to `results/runs.jsonl`. Each row is tagged with the instant-vfs
git HEAD, whether the tree was dirty, and the free-form `--note`.

Full 10-task run (2 conditions × 1 trial) costs ~$2–3 in Anthropic API spend
on `claude-sonnet-4-5`. Use `--task T03` or `--condition gitvfs` during
iteration to keep cost bounded.

## Diffing

```bash
# Default: compare the two most recent benchRunIds in runs.jsonl
bun bench/agents/diff.ts

# Compare specific invocations
bun bench/agents/diff.ts --before-run 2026-04-22T00-47-07-577 --after-run 2026-04-22T01-23-12-345

# Compare two git revisions of runs.jsonl
bun bench/agents/diff.ts --before HEAD~1 --after HEAD

# Compare two explicit files
bun bench/agents/diff.ts --before-file old.jsonl --after-file new.jsonl
```

The diff is per-task × per-condition. Regressions (>5%) flagged ⚠, wins ✅.

## The loop

1. `bun bench/agents/bench.ts --note "baseline before X"`
2. `git add bench/agents/results && git commit -m "bench: baseline for X"`
3. Ship the gitvfs change (AS-xxx TDD + deploy).
4. `bun bench/agents/bench.ts --note "after X"`
5. `bun bench/agents/diff.ts` — did the change help?
6. `git commit -m "bench: after X (ΔX% cost, ΔY% calls)"`

Bench results are themselves a git-tracked artifact. `git log bench/agents/results/runs.jsonl`
tells you the timeline of every measurement.

## Run record schema

Each line of `runs.jsonl` is a `RunSummary`:

```ts
{
  runId: string,                      // <benchRunId>-<taskId>-<condition>-<trial>
  benchRunId: string,                 // shared across all rows of one invocation
  ts: string,                         // ISO run start
  model: string,
  workerCommit: string,               // git HEAD of instant-vfs at bench time
  workerDirty: boolean,
  note: string | null,

  taskId: string,
  condition: "baseline" | "gitvfs",
  trial: number,
  category: string,

  passed: boolean,
  answer: string,

  toolCalls: number,
  iterations: number,
  wallClockMs: number,
  stopReason: string | null,

  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number,
  cacheReadTokens: number,
  costUsd: number,

  traceFile: string,                  // relative path to traces/<runId>.jsonl
}
```

Each line of a trace file is a `TraceEvent`:

```ts
{
  t: number,                          // ms from run start
  url: string,
  status: number | null,
  error?: string,
  bytes: number,                      // total bytes the server returned
  truncatedAt: number | null,         // if we truncated, byte offset
  respContentType: string | null,
  gitvfsHeaders?: {...},              // all x-gitvfs-* response headers
  body: string,                       // capped to 50KB
  elapsedMs: number,
}
```

## Task format

Tasks live in `tasks.jsonl`, one per line:

```json
{
  "id": "T01",
  "repo": "honojs/hono",
  "ref": "cf2d2b7edcf07adef2db7614557f4d7f9e2be7ba",
  "category": "discovery",
  "question": "...",
  "expected": { "type": "regex", "pattern": "src/middleware/body-limit/index\\.ts" }
}
```

Expected types: `exact` (string), `regex` (pattern), `contains-all` (array).
Graders are deterministic; no LLM-as-judge.

## Caveats

- `n=1 trial` by default. Baseline is noisy across runs — variance is real.
  Use `--trials 3` when a small effect matters.
- Tasks pinned to popular repos can leak through model memory. We mitigate
  by asking for line numbers and specific nested paths, but not eliminated.
- `baseline` uses raw `http_get`, not Claude's summarizing `WebFetch`. Real
  production agents using `WebFetch` will see a larger gap than we measure.
- Traces are capped at 50KB per call. Bodies bigger than that are truncated
  in both the agent's view and the saved trace, so runs remain reproducible.
