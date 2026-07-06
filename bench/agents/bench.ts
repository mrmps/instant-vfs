// gitvfs-bench: paired agent evaluation with full trace capture.
//
//   Same model, same task, same tool, two system prompts.
//   - Condition A (baseline): agent only knows about github.com
//   - Condition B (gitvfs):   agent additionally knows about gitvfs.miryaboy.workers.dev
//
// Per task, we record a run summary (one line appended to results/runs.jsonl)
// AND a full trace file under results/traces/<runId>.jsonl. Summaries power
// diffs across benchmark invocations; traces let us re-diagnose individual
// runs without rerunning the agent.
//
// Every run is tagged with `workerCommit` (git HEAD of this repo at bench-time),
// so when you git log results/runs.jsonl you can see which gitvfs source
// produced each data point.
//
// Usage:
//   # Anthropic (default)
//   ANTHROPIC_API_KEY=sk-ant-... bun bench/agents/bench.ts
//   ANTHROPIC_API_KEY=sk-ant-... bun bench/agents/bench.ts --task T03 --trials 3
//   ANTHROPIC_API_KEY=sk-ant-... bun bench/agents/bench.ts --note "AS-004..008 deploy"
//
//   # OpenRouter — uses OpenRouter's Anthropic-compatible /v1/messages endpoint,
//   # so the Anthropic SDK just works against any OR-hosted model that supports
//   # tool use. Cost comes directly from OR's reported usage.cost when present.
//   OPENROUTER_API_KEY=sk-or-... bun bench/agents/bench.ts \
//     --provider openrouter --model minimax/minimax-m2.5

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

type Provider = "anthropic" | "openrouter";

// USD per 1M tokens. Used when the upstream response doesn't include
// usage.cost (Anthropic never does; OpenRouter does). Models without
// an entry fall back to conservative Anthropic-class pricing.
const PRICING: Record<string, {
  input: number; output: number; cacheWrite?: number; cacheRead?: number;
}> = {
  "claude-sonnet-4-5":     { input: 3.0,  output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },
  "claude-haiku-4-5":      { input: 0.8,  output: 4.0,  cacheWrite: 1.0,  cacheRead: 0.08 },
  "minimax/minimax-m2.5":  { input: 0.30, output: 1.20, cacheRead: 0.075 },
};

function priceFor(model: string) {
  return PRICING[model] ?? { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.30 };
}

const MAX_TOOL_ITERS = 12;
const MAX_RESP_BYTES = 50_000;
// Cap per-tool-call body we PERSIST in the trace file (not what the agent sees).
// The agent always sees up to MAX_RESP_BYTES. Traces get the same cap so we
// can diagnose whatever the agent reasoned over.
const TRACE_BODY_CAP = MAX_RESP_BYTES;

type Task = {
  id: string;
  repo: string;
  ref: string;
  category: string;
  question: string;
  expected:
    | { type: "exact"; value: string }
    | { type: "regex"; pattern: string }
    | { type: "contains-all"; values: string[] };
};

const PROMPT_SHARED = `You are answering one short factual question about a public GitHub repository.

Protocol:
- Make the minimum number of fetches needed. Prefer narrow reads over broad ones.
- When you have the answer, reply with a FINAL message whose content is ONLY:
  {"answer": "<your answer>"}
  Do not call any tools after you answer. No prose, no reasoning, no backticks.
`;

const PROMPT_BASELINE = PROMPT_SHARED + `
You have one tool: http_get(url). You can fetch any of:
  - https://github.com/<owner>/<repo>/... (rendered pages)
  - https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path> (raw files)
  - https://api.github.com/repos/<owner>/<repo>/... (GitHub REST API, unauthenticated)

Responses are truncated at ${MAX_RESP_BYTES} bytes. Plan your fetches accordingly.
`;

const PROMPT_GITVFS = PROMPT_SHARED + `
You have one tool: http_get(url). In addition to github.com, you have:

  https://gitvfs.miryaboy.workers.dev — an HTTP virtual filesystem for any public
  GitHub repo. Replace github.com with that host for machine-friendly output.

Core endpoints (see /llms.txt for the full catalog):
  GET /<owner>/<repo>[@<ref>]/tree[/<subpath>]?depth=1&glob=<g>&count=1
      directory listing (one-level, globbed, or count-only)
  GET /<owner>/<repo>[@<ref>]/outline/<path>?depth=2
      top-level symbols and imports with line numbers — USE THIS for
      "what line does symbol X start on" questions (do NOT slice /file + count)
  GET /<owner>/<repo>[@<ref>]/symbol/<path>?name=<sym>
      single symbol's {name, line, endLine, kind, signature} in one call
  GET /<owner>/<repo>[@<ref>]/grep?q=<pat>&files_only=1&limit=<n>&regex=1&symbols=1
      ripgrep-style search; ?symbols=1 adds inSymbol on each match
  GET /<owner>/<repo>[@<ref>]/file/<path>?lines=<A>-<B>&numbered=1
      raw file bytes; ?lines=10-50 slices; &numbered=1 prepends ` + "`N | `" + ` per line
  GET /<owner>/<repo>[@<ref>]/stat/<path>
      {size, mime, lines, language}

Responses are truncated at ${MAX_RESP_BYTES} bytes. Plan your fetches accordingly.
`;

function loadTasks(): Task[] {
  const raw = readFileSync(
    join(import.meta.dir, "tasks.jsonl"),
    "utf-8",
  );
  return raw.trim().split("\n").map((line) => JSON.parse(line) as Task);
}

type TraceEvent = {
  t: number;              // ms from run start
  url: string;
  status: number | null;  // null on network error
  error?: string;
  bytes: number;
  truncatedAt: number | null;
  respContentType: string | null;
  gitvfsHeaders?: Record<string, string>;  // x-gitvfs-* — rich provenance
  body: string;           // capped to TRACE_BODY_CAP
  elapsedMs: number;
};

// If we have GITVFS_INTERNAL_KEY set, pass it on gitvfs requests so that
// the per-IP rate limits don't trip when bench fans out concurrently.
// (The per-SHA throttle still applies, but that's cheap.)
const GITVFS_KEY = process.env.GITVFS_INTERNAL_KEY ?? null;
function headersFor(url: string): Record<string, string> {
  const h: Record<string, string> = { "user-agent": "gitvfs-bench/0.3" };
  if (GITVFS_KEY && url.includes("gitvfs.miryaboy.workers.dev")) {
    h["x-gitvfs-key"] = GITVFS_KEY;
  }
  return h;
}

async function httpGet(url: string): Promise<{ agentView: string; trace: Omit<TraceEvent, "t"> }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: headersFor(url),
      redirect: "follow",
    });
    const raw = await res.arrayBuffer();
    const totalBytes = raw.byteLength;
    const sliced = new Uint8Array(raw).slice(0, MAX_RESP_BYTES);
    const body = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
    const truncated = totalBytes > MAX_RESP_BYTES;
    const elapsed = Date.now() - t0;

    const gitvfsHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k.startsWith("x-gitvfs-")) gitvfsHeaders[k] = v;
    });

    const agentView =
      `HTTP ${res.status} ${res.statusText}\n` +
      `content-type: ${res.headers.get("content-type") ?? "?"}\n` +
      `bytes: ${totalBytes}${truncated ? ` (truncated to ${MAX_RESP_BYTES})` : ""}\n` +
      `fetch-ms: ${elapsed}\n` +
      `---\n` +
      body;

    return {
      agentView,
      trace: {
        url,
        status: res.status,
        bytes: totalBytes,
        truncatedAt: truncated ? MAX_RESP_BYTES : null,
        respContentType: res.headers.get("content-type"),
        gitvfsHeaders: Object.keys(gitvfsHeaders).length ? gitvfsHeaders : undefined,
        body: body.slice(0, TRACE_BODY_CAP),
        elapsedMs: elapsed,
      },
    };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    return {
      agentView: `HTTP_GET_ERROR: ${msg}`,
      trace: {
        url,
        status: null,
        error: msg,
        bytes: 0,
        truncatedAt: null,
        respContentType: null,
        body: "",
        elapsedMs: Date.now() - t0,
      },
    };
  }
}

function grade(answer: string, expected: Task["expected"]): boolean {
  const a = answer.trim();
  if (expected.type === "exact") {
    return a === expected.value || a.includes(expected.value);
  }
  if (expected.type === "regex") {
    return new RegExp(expected.pattern).test(a);
  }
  if (expected.type === "contains-all") {
    return expected.values.every((v) =>
      new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(a),
    );
  }
  return false;
}

type RunSummary = {
  runId: string;              // <benchRunId>-<taskId>-<condition>-<trial>
  benchRunId: string;         // shared across all runs in a single bench invocation
  ts: string;                 // ISO start time of this run
  provider: Provider;
  model: string;
  workerCommit: string;       // git HEAD of instant-vfs at bench-time
  workerDirty: boolean;       // uncommitted changes when bench ran
  note: string | null;        // free-form --note arg

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
  costSource: "upstream" | "computed";  // did we use resp.usage.cost or table?

  traceFile: string;          // relative path: traces/<runId>.jsonl
};

function cost(model: string, u: {
  inputTokens: number; outputTokens: number;
  cacheWriteTokens: number; cacheReadTokens: number;
}): number {
  const p = priceFor(model);
  return (
    (u.inputTokens * p.input) / 1e6 +
    (u.outputTokens * p.output) / 1e6 +
    (u.cacheWriteTokens * (p.cacheWrite ?? p.input)) / 1e6 +
    (u.cacheReadTokens * (p.cacheRead ?? p.input * 0.1)) / 1e6
  );
}

type RunContext = {
  task: Task;
  condition: "baseline" | "gitvfs";
  trial: number;
  benchRunId: string;
  provider: Provider;
  model: string;
  workerCommit: string;
  workerDirty: boolean;
  note: string | null;
  resultsDir: string;
};

async function runOne(client: Anthropic, ctx: RunContext): Promise<RunSummary> {
  const { task, condition, trial } = ctx;
  const system = condition === "gitvfs" ? PROMPT_GITVFS : PROMPT_BASELINE;
  const userMsg =
    `Repo: ${task.repo}\n` +
    `Ref (full SHA): ${task.ref}\n` +
    `Question: ${task.question}`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMsg },
  ];

  const tools: Anthropic.Tool[] = [
    {
      name: "http_get",
      description: `HTTP GET a URL and return the response body as text (first ${MAX_RESP_BYTES} bytes). Headers (status, content-type, byte count) are prepended.`,
      input_schema: {
        type: "object",
        properties: { url: { type: "string", description: "Full URL including scheme" } },
        required: ["url"],
      },
    },
  ];

  const runId = `${ctx.benchRunId}-${task.id}-${condition}-${trial}`;
  const traceFile = join("traces", `${runId}.jsonl`);
  const tracePath = join(ctx.resultsDir, traceFile);
  mkdirSync(join(ctx.resultsDir, "traces"), { recursive: true });
  const traceStream = createWriteStream(tracePath, { flags: "w" });
  const writeTraceEvent = (ev: TraceEvent) => {
    traceStream.write(JSON.stringify(ev) + "\n");
  };

  let toolCalls = 0;
  let inputTokens = 0, outputTokens = 0, cacheWriteTokens = 0, cacheReadTokens = 0;
  let upstreamCostUsd = 0;
  let upstreamCostSeen = false;
  let answer = "";
  let stopReason: string | null = null;
  const t0 = Date.now();
  let iters = 0;

  try {
    for (; iters < MAX_TOOL_ITERS; iters++) {
      const resp = await client.messages.create({
        model: ctx.model,
        max_tokens: 2048,
        system: [{
          type: "text",
          text: system,
          cache_control: { type: "ephemeral" },
        }],
        tools,
        messages,
      });

      inputTokens += resp.usage.input_tokens ?? 0;
      outputTokens += resp.usage.output_tokens ?? 0;
      cacheWriteTokens += (resp.usage as any).cache_creation_input_tokens ?? 0;
      cacheReadTokens += (resp.usage as any).cache_read_input_tokens ?? 0;
      // OpenRouter surfaces an authoritative cost; prefer it when present.
      const upstreamCost = (resp.usage as any).cost;
      if (typeof upstreamCost === "number" && Number.isFinite(upstreamCost)) {
        upstreamCostUsd += upstreamCost;
        upstreamCostSeen = true;
      }
      stopReason = resp.stop_reason;

      messages.push({ role: "assistant", content: resp.content });

      const toolUses = resp.content.filter((b) => b.type === "tool_use");
      if (toolUses.length === 0) {
        answer = resp.content
          .filter((b) => b.type === "text")
          .map((b) => (b as any).text)
          .join("")
          .trim();
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        if (tu.type !== "tool_use") continue;
        if (tu.name !== "http_get") {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "ERROR: unknown tool",
            is_error: true,
          });
          continue;
        }
        const url = (tu.input as any).url as string;
        toolCalls++;
        const { agentView, trace } = await httpGet(url);
        writeTraceEvent({ t: Date.now() - t0, ...trace });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: agentView,
        });
      }
      messages.push({ role: "user", content: toolResults });
    }
  } finally {
    await new Promise<void>((resolve) => traceStream.end(() => resolve()));
  }

  const wallClockMs = Date.now() - t0;

  // Pull answer out of {"answer": "..."} if present.
  let parsed = answer;
  const m = answer.match(/\{[\s\S]*?"answer"\s*:\s*"([\s\S]*?)"\s*\}/);
  if (m) parsed = m[1];

  const passed = parsed ? grade(parsed, task.expected) : false;

  const costUsd = upstreamCostSeen
    ? upstreamCostUsd
    : cost(ctx.model, { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens });

  return {
    runId,
    benchRunId: ctx.benchRunId,
    ts: new Date(t0).toISOString(),
    provider: ctx.provider,
    model: ctx.model,
    workerCommit: ctx.workerCommit,
    workerDirty: ctx.workerDirty,
    note: ctx.note,
    taskId: task.id,
    condition,
    trial,
    category: task.category,
    passed,
    answer: parsed,
    toolCalls,
    iterations: iters + 1,
    wallClockMs,
    stopReason,
    inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens,
    costUsd,
    costSource: upstreamCostSeen ? "upstream" : "computed",
    traceFile,
  };
}

function fmtUsd(x: number): string { return `$${x.toFixed(4)}`; }
function fmtMs(x: number): string { return `${(x / 1000).toFixed(1)}s`; }

function markdownReport(rows: RunSummary[], tasks: Task[]): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const delta = (base: number, treat: number) =>
    base === 0 ? "—" : `${((treat - base) / base * 100).toFixed(1)}%`;
  const agg = (xs: RunSummary[]) => {
    if (xs.length === 0) return null;
    const mean = (f: (r: RunSummary) => number) =>
      xs.reduce((s, r) => s + f(r), 0) / xs.length;
    return {
      n: xs.length,
      pass: xs.filter((r) => r.passed).length,
      passRate: xs.filter((r) => r.passed).length / xs.length,
      meanToolCalls: mean((r) => r.toolCalls),
      meanWallClockMs: mean((r) => r.wallClockMs),
      meanInputTokens: mean((r) => r.inputTokens),
      meanOutputTokens: mean((r) => r.outputTokens),
      meanCostUsd: mean((r) => r.costUsd),
      totalCostUsd: xs.reduce((s, r) => s + r.costUsd, 0),
    };
  };

  const b = agg(rows.filter((r) => r.condition === "baseline"))!;
  const g = agg(rows.filter((r) => r.condition === "gitvfs"))!;

  let out = `# gitvfs-bench results\n\n`;
  out += `Provider: \`${rows[0]?.provider ?? "?"}\`  \n`;
  out += `Model: \`${rows[0]?.model ?? "?"}\`  \n`;
  out += `Worker commit: \`${rows[0]?.workerCommit ?? "?"}\`${rows[0]?.workerDirty ? " (dirty)" : ""}  \n`;
  if (rows[0]?.note) out += `Note: ${rows[0].note}  \n`;
  out += `Tasks: ${tasks.length}  \n`;
  out += `Runs total: ${rows.length}\n\n`;

  out += `## Headline\n\n`;
  out += `| Metric | Baseline | gitvfs | Δ |\n|---|---:|---:|---:|\n`;
  if (b && g) {
    out += `| Pass rate | ${pct(b.passRate)} (${b.pass}/${b.n}) | ${pct(g.passRate)} (${g.pass}/${g.n}) | ${(g.passRate - b.passRate >= 0 ? "+" : "")}${((g.passRate - b.passRate) * 100).toFixed(1)} pp |\n`;
    out += `| Mean wall-clock | ${fmtMs(b.meanWallClockMs)} | ${fmtMs(g.meanWallClockMs)} | ${delta(b.meanWallClockMs, g.meanWallClockMs)} |\n`;
    out += `| Mean tool calls | ${b.meanToolCalls.toFixed(1)} | ${g.meanToolCalls.toFixed(1)} | ${delta(b.meanToolCalls, g.meanToolCalls)} |\n`;
    out += `| Mean input tokens | ${b.meanInputTokens.toFixed(0)} | ${g.meanInputTokens.toFixed(0)} | ${delta(b.meanInputTokens, g.meanInputTokens)} |\n`;
    out += `| Mean cost / task | ${fmtUsd(b.meanCostUsd)} | ${fmtUsd(g.meanCostUsd)} | ${delta(b.meanCostUsd, g.meanCostUsd)} |\n`;
    out += `| Total spend | ${fmtUsd(b.totalCostUsd)} | ${fmtUsd(g.totalCostUsd)} | — |\n`;
  }
  out += `\n`;

  out += `## Per-task\n\n`;
  out += `| Task | Category | BL pass | VFS pass | BL calls | VFS calls | BL ms | VFS ms | BL $ | VFS $ |\n`;
  out += `|---|---|:-:|:-:|---:|---:|---:|---:|---:|---:|\n`;
  for (const t of tasks) {
    const br = rows.filter((r) => r.taskId === t.id && r.condition === "baseline");
    const gr = rows.filter((r) => r.taskId === t.id && r.condition === "gitvfs");
    const avg = (xs: RunSummary[], f: (r: RunSummary) => number) =>
      xs.length ? xs.reduce((s, r) => s + f(r), 0) / xs.length : 0;
    const passMark = (xs: RunSummary[]) => {
      if (!xs.length) return "—";
      const p = xs.filter((r) => r.passed).length;
      return `${p}/${xs.length}`;
    };
    out += `| ${t.id} | ${t.category} | ${passMark(br)} | ${passMark(gr)} | ${avg(br, r => r.toolCalls).toFixed(1)} | ${avg(gr, r => r.toolCalls).toFixed(1)} | ${avg(br, r => r.wallClockMs).toFixed(0)} | ${avg(gr, r => r.wallClockMs).toFixed(0)} | ${fmtUsd(avg(br, r => r.costUsd))} | ${fmtUsd(avg(gr, r => r.costUsd))} |\n`;
  }
  return out;
}

function gitInfo(): { commit: string; dirty: boolean } {
  try {
    const commit = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
    const dirty =
      execSync("git status --porcelain", { encoding: "utf-8" }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: "unknown", dirty: false };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const argOf = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] ?? null : null;
  };

  const taskFilter = argOf("--task");
  const trials = Number(argOf("--trials") ?? "1");
  const condArg = argOf("--condition");
  const conds: Array<"baseline" | "gitvfs"> = condArg
    ? [condArg as "baseline" | "gitvfs"]
    : ["baseline", "gitvfs"];
  const note = argOf("--note");
  const provider = (argOf("--provider") ?? "anthropic") as Provider;
  // Model default by provider; caller can always override with --model.
  const defaultModel =
    provider === "openrouter" ? "minimax/minimax-m2.5" : "claude-sonnet-4-5";
  const model = argOf("--model") ?? defaultModel;

  let client: Anthropic;
  if (provider === "openrouter") {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error("OPENROUTER_API_KEY not set");
      process.exit(1);
    }
    // OpenRouter's /api/v1/messages speaks the Anthropic Messages API.
    // Pass baseURL so the SDK dispatches there instead of api.anthropic.com.
    client = new Anthropic({
      apiKey,
      baseURL: "https://openrouter.ai/api",
      defaultHeaders: {
        "http-referer": "https://gitvfs.miryaboy.workers.dev",
        "x-title": "gitvfs-bench",
      },
    });
  } else {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY not set");
      process.exit(1);
    }
    client = new Anthropic({ apiKey });
  }

  let tasks = loadTasks();
  if (taskFilter) tasks = tasks.filter((t) => t.id === taskFilter);
  if (tasks.length === 0) {
    console.error("No tasks match filter");
    process.exit(1);
  }

  const { commit: workerCommit, dirty: workerDirty } = gitInfo();
  const resultsDir = join(import.meta.dir, "results");
  mkdirSync(resultsDir, { recursive: true });
  const runsJsonl = join(resultsDir, "runs.jsonl");
  const benchRunId = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");

  process.stderr.write(
    `bench run ${benchRunId}  provider=${provider}  model=${model}  worker=${workerCommit.slice(0, 7)}${workerDirty ? "+dirty" : ""}` +
    (note ? `  note="${note}"` : "") + "\n",
  );

  // Build job queue upfront; a worker pool consumes it concurrently.
  // Default concurrency matches the job count — i.e. full fan-out. Agent
  // calls are independent and network-bound, so this cuts a 20-job run from
  // many minutes down to one agent's wall-clock.
  //
  // If we have GITVFS_INTERNAL_KEY set, we send it as x-gitvfs-key on every
  // request to the deployed worker, which bypasses the per-IP rate limiter.
  // Without that key, Cloudflare's RL_EXPENSIVE would 429 the grep calls
  // once we fan out past ~3-4 concurrent. Use --concurrency N to override.
  //
  // Caveat: concurrent runs compete for network, so individual wallClockMs
  // numbers get ~10-20% noisier. For paired comparisons (baseline vs gitvfs
  // under the same contention) the delta is still meaningful — just don't
  // treat absolute ms as high-precision.
  const requestedConc = argOf("--concurrency");

  type Job = { task: Task; condition: "baseline" | "gitvfs"; trial: number };
  const jobs: Job[] = [];
  for (const task of tasks) {
    for (const condition of conds) {
      for (let trial = 0; trial < trials; trial++) {
        jobs.push({ task, condition, trial });
      }
    }
  }

  const concurrency = requestedConc
    ? Math.max(1, Number(requestedConc))
    : jobs.length;

  const rows: RunSummary[] = [];
  let done = 0;
  let cursor = 0;
  process.stderr.write(
    `pool concurrency=${concurrency}, jobs=${jobs.length}, ` +
    `gitvfs-bypass=${GITVFS_KEY ? "on" : "off"}\n`,
  );

  const workerLoop = async (workerIdx: number) => {
    while (true) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const { task, condition, trial } = jobs[i];
      const t0 = Date.now();
      process.stderr.write(`  → [w${workerIdx}] ${task.id} ${condition} #${trial + 1} starting\n`);
      try {
        const r = await runOne(client, {
          task, condition, trial,
          benchRunId, provider, model,
          workerCommit, workerDirty, note,
          resultsDir,
        });
        rows.push(r);
        appendFileSync(runsJsonl, JSON.stringify(r) + "\n");
        done++;
        process.stderr.write(
          `  ✓ [${done}/${jobs.length}] ${task.id} ${condition} ${r.passed ? "PASS" : "FAIL"} ` +
          `(${r.toolCalls} calls, ${fmtMs(r.wallClockMs)}, ${fmtUsd(r.costUsd)})\n`,
        );
      } catch (e: any) {
        const stub: RunSummary = {
          runId: `${benchRunId}-${task.id}-${condition}-${trial}`,
          benchRunId,
          ts: new Date(t0).toISOString(),
          provider, model,
          workerCommit, workerDirty, note,
          taskId: task.id, condition, trial,
          category: task.category,
          passed: false,
          answer: `ERROR: ${e.message}`,
          toolCalls: 0, iterations: 0,
          wallClockMs: Date.now() - t0,
          stopReason: "error",
          inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
          costUsd: 0,
          costSource: "computed",
          traceFile: join("traces", `${benchRunId}-${task.id}-${condition}-${trial}.jsonl`),
        };
        rows.push(stub);
        appendFileSync(runsJsonl, JSON.stringify(stub) + "\n");
        done++;
        process.stderr.write(
          `  ✗ [${done}/${jobs.length}] ${task.id} ${condition} ERROR ${e.message}\n`,
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, (_, i) => workerLoop(i + 1)),
  );

  const md = markdownReport(rows, tasks);
  const reportPath = join(resultsDir, `${benchRunId}-report.md`);
  writeFileSync(reportPath, md);
  console.log("\n" + md);
  console.log(`\nAppended ${rows.length} row(s) to bench/agents/results/runs.jsonl`);
  console.log(`Traces:  bench/agents/results/traces/${benchRunId}-*.jsonl`);
  console.log(`Report:  ${reportPath}`);
}

main();
