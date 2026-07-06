import { DurableObject } from "cloudflare:workers";
import { parseTar } from "./tar";
import { shouldSkip, mimeFor } from "./mime";
import { outline, detectLanguage, type OutlineItem } from "./outline";
import { runBash, type BashResult, type BashVfs } from "./bash";

function countLinesBytes(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) n++;
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) n++;
  return n;
}

function splitLogicalLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

// Any "ingesting" status older than this is treated as a zombie (Worker
// CPU-cap killed the previous invocation mid-stream) and retried.
const STALE_INGEST_MS = 3 * 60 * 1000;

// DO self-eviction: after this long of no activity, the DO's alarm fires and
// it wipes its own rows. Storage is bounded by the working-set size of the
// last N days' traffic, not by cumulative unique SHAs ever seen.
const EVICTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Upper bound on how often we re-arm the alarm. Every read "touches" the
// alarm but we only write storage at most once per hour per DO.
const ALARM_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

// Turn GitHub tarball fetch errors into actionable messages. Before this
// every failure looked like "tarball fetch 403" with no hint as to why.
function classifyTarballError(status: number, body: string): string {
  if (status === 404) return `tarball_not_found: repo or SHA does not exist (GitHub 404)`;
  if (status === 403) {
    if (/rate limit/i.test(body)) {
      return `tarball_rate_limited: GitHub API rate limit reached — set GITHUB_TOKEN or retry later`;
    }
    return `tarball_forbidden: GitHub returned 403 — private repo or blocked (403)`;
  }
  if (status === 451) return `tarball_unavailable_for_legal_reasons (451)`;
  if (status === 502 || status === 503 || status === 504) {
    return `tarball_upstream_unavailable: GitHub ${status}, retry may succeed`;
  }
  return `tarball_fetch_failed: GitHub ${status}`;
}

// Rate-limit decision returned by checkThrottle(). Callers surface this as
// HTTP 429 with a retry-after header.
export interface ThrottleDecision {
  allowed: boolean;
  retryAfterSec?: number;
  kind?: string;
}

// Per-IP rate limiter binding. Returns { success: boolean } from .limit().
// Namespaces defined in wrangler.toml via [[unsafe.bindings]].
export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

// Workers Analytics Engine binding. Non-blocking writes.
export interface MetricsBinding {
  writeDataPoint(point: {
    blobs?: string[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

export interface Env {
  REPO: DurableObjectNamespace<RepoDO>;
  GITHUB_TOKEN?: string;
  RL_EXPENSIVE?: RateLimiterBinding;
  RL_GENERAL?: RateLimiterBinding;
  RL_SUSTAINED?: RateLimiterBinding;
  RL_INGEST?: RateLimiterBinding;
  METRICS?: MetricsBinding;
  // Shared-secret that, when presented in the X-Gitvfs-Key request header,
  // exempts the request from per-IP rate limiting. Meant for our own tests,
  // benchmarks, and internal tooling. The per-SHA soft throttle still applies
  // — that's a safety net against our own bugs.
  GITVFS_INTERNAL_KEY?: string;
  // Cloudflare account id (public — visible in the deploy output) and an API
  // token scoped to `Account Analytics: Read`. Used by /admin/dashboard,
  // /admin/stats, and /popular to query the GraphQL Analytics API.
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
}

interface IngestStatus {
  // "not_ingested" = never-completed DO. Earlier versions called this "idle",
  // which agent traces showed was read as "ready to serve" — exactly the
  // opposite of what we mean.
  state: "not_ingested" | "ingesting" | "ready" | "error";
  sha?: string;
  owner?: string;
  repo?: string;
  startedAt?: number;
  finishedAt?: number;
  filesStored?: number;
  bytesStored?: number;
  error?: string;
}

export class RepoDO extends DurableObject<Env> {
  private sql;
  // In-memory: set once the DO instance has confirmed ingest for this SHA.
  // Avoids a SQL SELECT on every request. Survives for the life of the isolate.
  private readySha: string | null = null;
  private readyFilesStored: number = 0;
  private readyBytesStored: number = 0;

  // Sliding-window timestamps (ms) of recent expensive ops (bash / grep) on
  // this DO. Coarse per-SHA throttle to prevent one agent from hammering a
  // single commit — it's best-effort (evicted isolates reset the window) but
  // good enough to slow down a runaway script.
  private expensiveOps: number[] = [];

  // When this DO last pushed out its eviction alarm. We only re-set the
  // alarm at most once per hour to avoid write amplification.
  private lastAlarmRefreshAt: number = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mime TEXT NOT NULL,
        lines INTEGER,
        content BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Migrate pre-existing DO schemas (created before the `lines` column).
    try { this.sql.exec("ALTER TABLE files ADD COLUMN lines INTEGER"); } catch {}
  }

  private getMeta(key: string): string | null {
    const row = [...this.sql.exec<{ value: string }>(
      "SELECT value FROM meta WHERE key = ?", key,
    )][0];
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key, value,
    );
  }

  async status(): Promise<IngestStatus> {
    const s = this.getMeta("status");
    return s ? JSON.parse(s) : { state: "not_ingested" };
  }

  async ensureIngested(owner: string, repo: string, sha: string): Promise<IngestStatus> {
    // Hot path: no SQL round-trip when we've already confirmed this SHA in-memory.
    if (this.readySha === sha) {
      return {
        state: "ready", owner, repo, sha,
        filesStored: this.readyFilesStored,
        bytesStored: this.readyBytesStored,
      };
    }
    const status = await this.status();
    if (status.state === "ready" && status.sha === sha) {
      this.readySha = sha;
      this.readyFilesStored = status.filesStored ?? 0;
      this.readyBytesStored = status.bytesStored ?? 0;
      return status;
    }
    // If another invocation claims to be ingesting, trust it — but only if
    // its startedAt is recent. A Worker CPU-cap kill leaves status stuck on
    // "ingesting" forever; treat anything older than STALE_INGEST_MS as dead
    // and restart. This is the fix for the unreachable-large-repo bug.
    if (status.state === "ingesting" && status.sha === sha) {
      const age = Date.now() - (status.startedAt ?? 0);
      if (age < STALE_INGEST_MS) return status;
      // fall through — retry as if there was no prior attempt
    }
    return await this.ctx.blockConcurrencyWhile(async () => {
      const again = await this.status();
      if (again.state === "ready" && again.sha === sha) {
        this.readySha = sha;
        this.readyFilesStored = again.filesStored ?? 0;
        this.readyBytesStored = again.bytesStored ?? 0;
        return again;
      }
      const result = await this.doIngest(owner, repo, sha);
      if (result.state === "ready") {
        this.readySha = sha;
        this.readyFilesStored = result.filesStored ?? 0;
        this.readyBytesStored = result.bytesStored ?? 0;
        // First successful ingest schedules the self-eviction alarm.
        this.touchAlarm();
      }
      return result;
    });
  }

  private async doIngest(owner: string, repo: string, sha: string): Promise<IngestStatus> {
    // Important: do NOT DELETE FROM files here. A prior partial ingest may
    // have inserted rows that we can keep (INSERT OR REPLACE below is
    // idempotent per path). Wiping on retry guaranteed re-failure on big
    // repos that already burned CPU before the cap.
    this.readySha = null;
    const startedAt = Date.now();
    const status: IngestStatus = {
      state: "ingesting", owner, repo, sha, startedAt,
    };
    this.setMeta("status", JSON.stringify(status));

    // Fleet-wide cap on concurrent new ingests. Protects the GitHub 5000/hr
    // token budget AND prevents a flood of unique-repo requests from
    // ballooning total DO storage. Key="global" makes the limit shared
    // across all DO instances. Limit lives in wrangler.toml (RL_INGEST).
    if (this.env.RL_INGEST) {
      const ok = await this.env.RL_INGEST.limit({ key: "global" });
      if (!ok.success) {
        const err: IngestStatus = {
          state: "error", owner, repo, sha, startedAt,
          finishedAt: Date.now(),
          error: "ingest_rate_limited_global: too many new repo ingests in flight. Retry in ~60s.",
        };
        this.setMeta("status", JSON.stringify(err));
        return err;
      }
    }

    // Max uncompressed-tarball bytes we'll pull from a single repo.
    // Anything larger likely won't fit in the Worker CPU budget anyway —
    // capping upfront prevents partial-ingest churn and DO storage
    // surprises. 250MB covers ~all real codebases (react/next.js fit).
    const MAX_TARBALL_BYTES = 250 * 1024 * 1024;

    try {
      const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`;
      const headers: Record<string, string> = {
        "User-Agent": "gitvfs/0.1",
        Accept: "application/vnd.github+json",
      };
      if (this.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${this.env.GITHUB_TOKEN}`;
      let res = await fetch(url, { headers, redirect: "follow" });
      // Mirror resolveRef: an expired/invalid token 401s here too. Retry
      // unauthenticated so public-repo tarballs still download instead of
      // failing the whole ingest.
      if (res.status === 401 && this.env.GITHUB_TOKEN) {
        const { Authorization, ...anon } = headers;
        res = await fetch(url, { headers: anon, redirect: "follow" });
      }
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        const msg = classifyTarballError(res.status, body);
        throw new Error(msg);
      }

      // Wrap the body in a TransformStream that aborts if we exceed the
      // tarball byte cap. We measure the COMPRESSED stream (cheaper —
      // happens before gzip decode) so the cap is conservative on actual
      // disk usage. 250MB compressed is plenty for source-only repos.
      let downloaded = 0;
      const guarded = res.body.pipeThrough(new TransformStream({
        transform(chunk: Uint8Array, controller) {
          downloaded += chunk.byteLength;
          if (downloaded > MAX_TARBALL_BYTES) {
            controller.error(new Error(
              `tarball_too_large: ${owner}/${repo}@${sha.slice(0,7)} exceeds ${Math.round(MAX_TARBALL_BYTES / 1024 / 1024)}MB compressed cap`,
            ));
            return;
          }
          controller.enqueue(chunk);
        },
      }) as unknown as TransformStream<Uint8Array, Uint8Array>);
      const unzipped = (guarded as unknown as ReadableStream<BufferSource>).pipeThrough(new DecompressionStream("gzip"));

      let filesStored = 0;
      let bytesStored = 0;

      for await (const entry of parseTar(unzipped)) {
        if (entry.type !== "file") continue;
        const slash = entry.path.indexOf("/");
        const path = slash >= 0 ? entry.path.slice(slash + 1) : entry.path;
        if (!path) continue;

        const skip = shouldSkip(path, entry.size);
        if (skip) continue;

        this.sql.exec(
          "INSERT OR REPLACE INTO files (path, size, mime, lines, content) VALUES (?, ?, ?, ?, ?)",
          path, entry.size, mimeFor(path), countLinesBytes(entry.bytes), entry.bytes,
        );
        filesStored++;
        bytesStored += entry.size;
      }

      const finished: IngestStatus = {
        state: "ready",
        owner, repo, sha,
        startedAt,
        finishedAt: Date.now(),
        filesStored,
        bytesStored,
      };
      this.setMeta("status", JSON.stringify(finished));
      return finished;
    } catch (e: any) {
      const err: IngestStatus = {
        state: "error", owner, repo, sha, startedAt,
        finishedAt: Date.now(),
        error: e?.message ?? String(e),
      };
      this.setMeta("status", JSON.stringify(err));
      return err;
    }
  }

  async treeCount(opts: { glob?: string; prefix?: string } = {}): Promise<number> {
    const prefix = opts.prefix?.replace(/^\/+|\/+$/g, "") ?? "";
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (prefix) {
      clauses.push("(path = ? OR path LIKE ?)");
      args.push(prefix, prefix + "/%");
    }
    if (opts.glob) {
      clauses.push("path GLOB ?");
      args.push(opts.glob);
    }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const row = [...this.sql.exec<{ n: number }>(
      `SELECT count(*) AS n FROM files ${where}`, ...args,
    )][0];
    return row?.n ?? 0;
  }

  async tree(opts: { glob?: string; prefix?: string; withSizes?: boolean } = {}): Promise<
    { path: string; size?: number; lines?: number }[]
  > {
    // Normalize prefix: no leading/trailing slashes.
    const prefix = opts.prefix?.replace(/^\/+|\/+$/g, "") ?? "";
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (prefix) {
      clauses.push("(path = ? OR path LIKE ?)");
      args.push(prefix, prefix + "/%");
    }
    if (opts.glob) {
      clauses.push("path GLOB ?");
      args.push(opts.glob);
    }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const sql = opts.withSizes
      ? `SELECT path, size, lines FROM files ${where} ORDER BY path`
      : `SELECT path FROM files ${where} ORDER BY path`;
    const rows = this.sql.exec<{ path: string; size?: number; lines?: number | null }>(sql, ...args);
    return opts.withSizes
      ? [...rows].map((r) => {
          const entry: { path: string; size?: number; lines?: number } = { path: r.path, size: r.size };
          if (typeof r.lines === "number") entry.lines = r.lines;
          return entry;
        })
      : [...rows].map((r) => ({ path: r.path }));
  }

  async treeWithOutlines(
    opts: {
      glob?: string;
      prefix?: string;
      maxFiles?: number;
      depth?: number;
      comments?: boolean;
    } = {},
  ): Promise<{
    truncated: boolean;
    entries: Array<{
      path: string;
      size: number;
      lines: number;
      language: string;
      mime: string;
      items: OutlineItem[];
      imports: string[];
    }>;
  }> {
    const prefix = opts.prefix?.replace(/^\/+|\/+$/g, "") ?? "";
    const maxFiles = Math.min(Math.max(1, opts.maxFiles ?? 500), 2000);
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (prefix) {
      clauses.push("(path = ? OR path LIKE ?)");
      args.push(prefix, prefix + "/%");
    }
    if (opts.glob) {
      clauses.push("path GLOB ?");
      args.push(opts.glob);
    }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    // +1 so we can tell if the caller's slice was truncated.
    const sql = `SELECT path, size, mime, lines, content FROM files ${where} ORDER BY path LIMIT ?`;
    const rows = this.sql.exec<{
      path: string; size: number; mime: string; lines: number | null; content: ArrayBuffer;
    }>(sql, ...args, maxFiles + 1);

    const decoder = new TextDecoder("utf-8", { fatal: false });
    const entries: Array<{
      path: string; size: number; lines: number; language: string; mime: string;
      items: OutlineItem[]; imports: string[];
    }> = [];
    let seen = 0;
    let truncated = false;
    for (const r of rows) {
      seen++;
      if (seen > maxFiles) { truncated = true; break; }
      const language = detectLanguage(r.path);
      // For non-source files we still list them — agents want to see the whole tree —
      // but we skip the regex scan since outline() would return nothing useful.
      let items: OutlineItem[] = [];
      let imports: string[] = [];
      let lineCount = typeof r.lines === "number" ? r.lines : 0;
      if (language !== "text") {
        const bytes = new Uint8Array(r.content);
        const body = decoder.decode(bytes);
        const outlineOpts: { depth?: number; comments?: boolean } = {};
        if (opts.depth !== undefined) outlineOpts.depth = opts.depth;
        if (opts.comments !== undefined) outlineOpts.comments = opts.comments;
        const o = outline(r.path, body, outlineOpts);
        items = o.items;
        imports = o.imports;
        lineCount = o.totalLines;
      }
      entries.push({
        path: r.path,
        size: r.size,
        lines: lineCount,
        language,
        mime: r.mime,
        items,
        imports,
      });
    }
    return { truncated, entries };
  }

  /**
   * One-level listing under a prefix: immediate file children + synthesized
   * directory entries. Equivalent to `ls <prefix>` — what agents actually want
   * when asking "what's in this folder?" rather than the flat recursive tree.
   */
  async treeLevel(opts: { prefix?: string } = {}): Promise<
    Array<{ path: string; kind: "file" | "dir"; size?: number; lines?: number }>
  > {
    const prefix = opts.prefix?.replace(/^\/+|\/+$/g, "") ?? "";
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (prefix) {
      clauses.push("(path = ? OR path LIKE ?)");
      args.push(prefix, prefix + "/%");
    }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const rows = [...this.sql.exec<{ path: string; size: number; lines: number | null }>(
      `SELECT path, size, lines FROM files ${where}`, ...args,
    )];

    const dirSet = new Set<string>();
    const files: Array<{ name: string; size: number; lines?: number }> = [];
    const pref = prefix ? prefix + "/" : "";
    for (const r of rows) {
      if (prefix && r.path !== prefix && !r.path.startsWith(pref)) continue;
      const rest = prefix ? r.path.slice(pref.length) : r.path;
      if (rest === "") continue; // exact match on a file with no suffix
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        dirSet.add(rest.slice(0, slash));
      } else {
        const entry: { name: string; size: number; lines?: number } = {
          name: rest, size: r.size,
        };
        if (typeof r.lines === "number") entry.lines = r.lines;
        files.push(entry);
      }
    }

    const out: Array<{ path: string; kind: "file" | "dir"; size?: number; lines?: number }> = [];
    for (const d of [...dirSet].sort()) {
      out.push({ path: pref + d, kind: "dir" });
    }
    for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const entry: { path: string; kind: "file"; size?: number; lines?: number } = {
        path: pref + f.name, kind: "file", size: f.size,
      };
      if (f.lines !== undefined) entry.lines = f.lines;
      out.push(entry);
    }
    return out;
  }

  /**
   * Batch file read: returns one entry per path, missing files surfaced as
   * `{path, error: "not_found"}` instead of failing the whole request.
   */
  async readMany(paths: ReadonlyArray<string>): Promise<
    Array<
      | { path: string; size: number; lines?: number; mime: string; language: string; content: string }
      | { path: string; error: "not_found" }
    >
  > {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const out: Array<
      | { path: string; size: number; lines?: number; mime: string; language: string; content: string }
      | { path: string; error: "not_found" }
    > = [];
    for (const raw of paths) {
      const path = raw.replace(/^\/+/, "");
      const row = [...this.sql.exec<{
        size: number; mime: string; lines: number | null; content: ArrayBuffer;
      }>(
        "SELECT size, mime, lines, content FROM files WHERE path = ?", path,
      )][0];
      if (!row) { out.push({ path, error: "not_found" }); continue; }
      const entry: {
        path: string; size: number; lines?: number; mime: string; language: string; content: string;
      } = {
        path,
        size: row.size,
        mime: row.mime,
        language: detectLanguage(path),
        content: decoder.decode(new Uint8Array(row.content)),
      };
      if (typeof row.lines === "number") entry.lines = row.lines;
      out.push(entry);
    }
    return out;
  }

  async suggestPaths(path: string, limit = 5): Promise<string[]> {
    // Find near-neighbor paths: same basename, or same parent dir, or substring match.
    const base = path.split("/").pop() ?? path;
    const parent = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
    const rows = this.sql.exec<{ path: string; score: number }>(
      `SELECT path,
         (CASE WHEN path = ? THEN 100 ELSE 0 END) +
         (CASE WHEN path LIKE ? THEN 50 ELSE 0 END) +
         (CASE WHEN path LIKE ? THEN 20 ELSE 0 END) AS score
       FROM files
       WHERE score > 0
       ORDER BY score DESC, length(path) ASC
       LIMIT ?`,
      path,
      `%/${base}`,
      parent ? `${parent}/%` : `%/${base.slice(0, Math.max(3, base.length - 2))}%`,
      limit,
    );
    return [...rows].map((r) => r.path);
  }

  async read(
    path: string,
  ): Promise<{ size: number; mime: string; lines?: number; content: Uint8Array } | null> {
    this.touchAlarm();
    const row = [...this.sql.exec<{
      size: number; mime: string; lines: number | null; content: ArrayBuffer;
    }>(
      "SELECT size, mime, lines, content FROM files WHERE path = ?", path,
    )][0];
    if (!row) return null;
    const bytes = new Uint8Array(row.content);
    const out: { size: number; mime: string; lines?: number; content: Uint8Array } = {
      size: row.size,
      mime: row.mime,
      content: bytes,
    };
    if (typeof row.lines === "number") {
      out.lines = row.lines;
    } else {
      // Self-healing migration: rows ingested before the `lines` column
      // existed come back with lines=NULL. Compute now and persist so future
      // reads are free. The UPDATE is cheap (O(bytes) count, no content copy).
      const lines = countLinesBytes(bytes);
      try {
        this.sql.exec("UPDATE files SET lines = ? WHERE path = ?", lines, path);
      } catch {
        // non-fatal — we'll just recompute next time
      }
      out.lines = lines;
    }
    return out;
  }

  async stat(
    path: string,
  ): Promise<{ path: string; size: number; mime: string; lines?: number; language: string } | null> {
    const row = [...this.sql.exec<{ size: number; mime: string; lines: number | null }>(
      "SELECT size, mime, lines FROM files WHERE path = ?", path,
    )][0];
    if (!row) return null;
    const out: { path: string; size: number; mime: string; lines?: number; language: string } = {
      path, size: row.size, mime: row.mime, language: detectLanguage(path),
    };
    if (typeof row.lines === "number") out.lines = row.lines;
    return out;
  }

  async grep(opts: {
    q: string;
    glob?: string;
    excludeGlob?: string[];
    caseInsensitive?: boolean;
    regex?: boolean;
    word?: boolean;
    limit?: number;
    context?: number;
    filesOnly?: boolean;
  }): Promise<{
    truncated: boolean;
    filesScanned: number;
    matchedFiles: number;
    matches: { path: string; line: number; text: string; before?: string[]; after?: string[] }[];
    files?: string[];
  }> {
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 10000);
    const ctxLines = Math.max(0, Math.min(opts.context ?? 0, 10));
    const flags = (opts.caseInsensitive ? "i" : "") + "m";

    // Build regex (caller has already validated).
    let basePattern = opts.regex
      ? opts.q
      : opts.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (opts.word) basePattern = `\\b(?:${basePattern})\\b`;
    const re = new RegExp(basePattern, flags);

    // SQL prefilter: literal LIKE only when not regex and not word-boundary (those need true regex).
    const coarse =
      !opts.regex && !opts.word
        ? (opts.caseInsensitive ? `%${opts.q.toLowerCase()}%` : `%${opts.q}%`)
        : null;

    const whereClauses: string[] = [];
    const args: unknown[] = [];
    if (opts.glob) {
      whereClauses.push("path GLOB ?");
      args.push(opts.glob);
    }
    if (opts.excludeGlob?.length) {
      for (const x of opts.excludeGlob) {
        whereClauses.push("NOT (path GLOB ?)");
        args.push(x);
      }
    }
    if (coarse !== null) {
      whereClauses.push(
        opts.caseInsensitive
          ? "lower(CAST(content AS TEXT)) LIKE ?"
          : "CAST(content AS TEXT) LIKE ?",
      );
      args.push(coarse);
    }

    const where = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";
    const rows = this.sql.exec<{ path: string; content: ArrayBuffer }>(
      `SELECT path, content FROM files ${where}`,
      ...args,
    );

    const out: { path: string; line: number; text: string; before?: string[]; after?: string[] }[] = [];
    const fileSet = new Set<string>();
    let filesScanned = 0;
    let truncated = false;
    const decoder = new TextDecoder("utf-8", { fatal: false });

    for (const row of rows) {
      filesScanned++;
      const text = decoder.decode(new Uint8Array(row.content));
      const lines = splitLogicalLines(text);
      let hitInThisFile = false;
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          if (opts.filesOnly) {
            fileSet.add(row.path);
            hitInThisFile = true;
            break;
          }
          const match: typeof out[number] = {
            path: row.path,
            line: i + 1,
            text: lines[i].slice(0, 400),
          };
          if (ctxLines > 0) {
            match.before = lines
              .slice(Math.max(0, i - ctxLines), i)
              .map((l) => l.slice(0, 400));
            match.after = lines
              .slice(i + 1, Math.min(lines.length, i + 1 + ctxLines))
              .map((l) => l.slice(0, 400));
          }
          out.push(match);
          if (out.length >= limit) {
            truncated = true;
            break;
          }
        }
      }
      if (opts.filesOnly && hitInThisFile && fileSet.size >= limit) {
        truncated = true;
        break;
      }
      if (!opts.filesOnly && truncated) break;
    }

    if (opts.filesOnly) {
      return {
        truncated,
        filesScanned,
        matchedFiles: fileSet.size,
        matches: [],
        files: [...fileSet].sort(),
      };
    }
    // Count distinct paths with >= 1 match for the full-match shape.
    const matchedPaths = new Set<string>();
    for (const m of out) matchedPaths.add(m.path);
    return { truncated, filesScanned, matchedFiles: matchedPaths.size, matches: out };
  }

  /**
   * Push out the eviction alarm. Called on every user-facing read so that
   * actively-used DOs stay alive and idle DOs self-destruct after TTL.
   * Throttled to at most one write per hour to limit write amplification.
   */
  private touchAlarm(): void {
    const now = Date.now();
    if (now - this.lastAlarmRefreshAt < ALARM_REFRESH_INTERVAL_MS) return;
    this.lastAlarmRefreshAt = now;
    this.ctx.storage.setAlarm(now + EVICTION_TTL_MS);
  }

  /**
   * Alarm handler: evicts this DO's data. Triggered EVICTION_TTL_MS after the
   * last touchAlarm(). A subsequent request re-ingests transparently (costs a
   * cold-ingest latency once, then warm again).
   */
  async alarm(): Promise<void> {
    const s = await this.status();
    if (s.state === "ingesting") {
      // Don't evict mid-ingest — reschedule and let the in-flight attempt
      // (or the stale-ingest retry path) run to completion first.
      this.ctx.storage.setAlarm(Date.now() + ALARM_REFRESH_INTERVAL_MS);
      return;
    }
    this.sql.exec("DELETE FROM files");
    this.sql.exec("DELETE FROM meta");
    this.readySha = null;
    this.readyFilesStored = 0;
    this.readyBytesStored = 0;
    this.expensiveOps = [];
    this.lastAlarmRefreshAt = 0;
    // No new alarm — DO sits empty until the next request re-ingests.
  }

  /**
   * Soft per-SHA throttle for expensive ops. Generous limit (60 calls / min)
   * catches obviously-abusive loops without bothering normal use.
   */
  checkThrottle(kind: "bash" | "grep", limitPerMin = 60): ThrottleDecision {
    const now = Date.now();
    const windowMs = 60_000;
    this.expensiveOps = this.expensiveOps.filter((t) => now - t < windowMs);
    if (this.expensiveOps.length >= limitPerMin) {
      const oldest = this.expensiveOps[0];
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
        kind,
      };
    }
    this.expensiveOps.push(now);
    return { allowed: true, kind };
  }

  async bash(script: string, opts: { timeoutMs?: number } = {}): Promise<BashResult> {
    this.touchAlarm();
    // Build an in-process VFS adapter over this DO's sqlite. No HTTP round
    // trips, no stub calls — all file ops run on the row storage directly.
    const vfs: BashVfs = {
      list: async ({ prefix, glob }) => {
        const entries = await this.tree({
          ...(prefix !== undefined ? { prefix } : {}),
          ...(glob !== undefined ? { glob } : {}),
          withSizes: true,
        });
        return entries.map((e) => {
          const anyE = e as { path: string; size?: number; lines?: number };
          const out: { path: string; size: number; lines?: number } = {
            path: anyE.path, size: anyE.size ?? 0,
          };
          if (typeof anyE.lines === "number") out.lines = anyE.lines;
          return out;
        });
      },
      read: async (path) => (await this.read(path))?.content ?? null,
      kind: async (path) => {
        if (!path) return "dir";
        const hasFile = [...this.sql.exec<{ x: number }>(
          "SELECT 1 as x FROM files WHERE path = ? LIMIT 1", path,
        )][0];
        if (hasFile) return "file";
        const hasUnder = [...this.sql.exec<{ x: number }>(
          "SELECT 1 as x FROM files WHERE path LIKE ? LIMIT 1", path + "/%",
        )][0];
        return hasUnder ? "dir" : null;
      },
      grep: async (opts2) => {
        const r = await this.grep({
          q: opts2.q,
          ...(opts2.glob !== undefined ? { glob: opts2.glob } : {}),
          ...(opts2.caseInsensitive !== undefined ? { caseInsensitive: opts2.caseInsensitive } : {}),
          ...(opts2.regex !== undefined ? { regex: opts2.regex } : {}),
          ...(opts2.word !== undefined ? { word: opts2.word } : {}),
          ...(opts2.filesOnly !== undefined ? { filesOnly: opts2.filesOnly } : {}),
          ...(opts2.limit !== undefined ? { limit: opts2.limit } : {}),
        });
        const out: { matches: { path: string; line: number; text: string }[]; truncated: boolean; files?: string[] } = {
          matches: r.matches,
          truncated: r.truncated,
        };
        if (r.files) out.files = r.files;
        return out;
      },
    };
    return runBash(script, vfs, opts);
  }

  async deleteAll() {
    this.sql.exec("DELETE FROM files");
    this.sql.exec("DELETE FROM meta");
  }
}
