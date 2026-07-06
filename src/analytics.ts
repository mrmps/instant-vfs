// Cloudflare Analytics Engine SQL API client for the `gitvfs_metrics` dataset.
//
// AE blob schema (written in worker.ts on every request):
//   blob1=action  blob2=source  blob3=status
//   blob4=owner   blob5=repo    blob6=refKind
//   double1=durationMs           index1=action
//
// We use the SQL API rather than GraphQL because GraphQL's
// `workersAnalyticsEngineAdaptiveGroups` does not expose custom-dataset
// blobs in its schema (only count + time dimensions). The SQL endpoint
// is ClickHouse SQL and supports the full blob/double surface.
//
// Required env:
//   CF_ACCOUNT_ID         account id (public; in wrangler.toml [vars])
//   CF_ANALYTICS_TOKEN    secret, scoped to Account Analytics: Read
//
// Results are cached per (kind, window, limit) in caches.default for 60s
// so refreshes don't spend CF Analytics quota or CPU.

const SQL_URL = (acct: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${acct}/analytics_engine/sql`;
const DATASET = "gitvfs_metrics";

export interface AnalyticsEnv {
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
}

export type Window = "1h" | "24h" | "7d" | "30d";

function windowToInterval(w: Window): string {
  // ClickHouse interval syntax.
  switch (w) {
    case "1h": return "INTERVAL '1' HOUR";
    case "24h": return "INTERVAL '1' DAY";
    case "7d": return "INTERVAL '7' DAY";
    case "30d": return "INTERVAL '30' DAY";
  }
}

export function isAnalyticsConfigured(env: AnalyticsEnv): boolean {
  return !!(env.CF_ACCOUNT_ID && env.CF_ANALYTICS_TOKEN);
}

interface SqlResponse<Row> {
  meta: { name: string; type: string }[];
  data: Row[];
  rows: number;
}

async function sql<Row>(env: AnalyticsEnv, query: string): Promise<Row[]> {
  if (!isAnalyticsConfigured(env)) {
    throw new Error("analytics_not_configured: set CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN");
  }
  const res = await fetch(SQL_URL(env.CF_ACCOUNT_ID!), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.CF_ANALYTICS_TOKEN}`,
      "content-type": "application/sql",
    },
    body: query + " FORMAT JSON",
  });
  if (!res.ok) {
    throw new Error(`sql_http_${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json() as SqlResponse<Row>;
  return body.data ?? [];
}

// Bump CACHE_VERSION whenever a StatsBundle / RepoDetail field is added or
// renamed — old cached blobs (60s TTL) would otherwise break renderers.
const CACHE_VERSION = "v5";
function cacheKey(kind: string, window: Window, limit: number): Request {
  return new Request(`https://gitvfs-cache.internal/analytics/${CACHE_VERSION}/${kind}/${window}/${limit}`);
}

async function cached<T>(kind: string, window: Window, limit: number, ttlSec: number, compute: () => Promise<T>): Promise<T> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = cacheKey(kind, window, limit);
  const hit = await cache.match(key);
  if (hit) return hit.json() as Promise<T>;
  const data = await compute();
  await cache.put(key, new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttlSec}` },
  }));
  return data;
}

// AE stores blobs as String; SUM(_sample_interval) is a UInt64 returned as
// a JSON string. Parse explicitly so the API surface returns numbers.
function n(x: unknown): number {
  if (typeof x === "number") return x;
  if (typeof x === "string") return Number(x) || 0;
  return 0;
}

// ----- Public shapes ------------------------------------------------------

export interface RepoRow {
  owner: string;
  repo: string;
  requests: number;
  errorRate: number;       // 0..1
  p50Ms: number;
  p95Ms: number;
}

export interface ActionRow {
  action: string;
  requests: number;
  p50Ms: number;
  p95Ms: number;
}

export interface StatusRow {
  status: string;
  requests: number;
}

export interface ErrorGroup {
  status: string;
  action: string;
  owner: string;
  repo: string;
  requests: number;
  p95Ms: number;
}

export interface ClientRow {
  client: string;
  requests: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  uniqueRepos: number;
}

export interface SlowRequestGroup {
  action: string;
  owner: string;
  repo: string;
  client: string;
  slowCount: number;       // requests > 5s
  total: number;
  p95Ms: number;
  p99Ms: number;
}

export interface FailureRow {
  minute: string;          // ISO truncated to minute (bucket)
  status: string;
  action: string;
  owner: string;
  repo: string;
  client: string;
  path: string;
  count: number;
  p95Ms: number;
}

export interface StatsBundle {
  window: Window;
  generatedAt: string;
  totalRequests: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  cacheHitRate: number;          // 0..1, fraction served from edge cache
  uniqueRepos: number;
  topRepos: RepoRow[];
  byAction: (ActionRow & { p99Ms: number })[];
  byStatus: StatusRow[];
  byClient: ClientRow[];
  topErrors: ErrorGroup[];
  timeSeries: TimeSeriesPoint[];
  ingestFailures: { owner: string; repo: string; reason: string; count: number }[];
  slowRequests: SlowRequestGroup[];
  recentFailures: FailureRow[];
}

// ----- Queries ------------------------------------------------------------

// We filter out the "-" sentinel (non-repo paths) and the empty string
// (rows written before the schema change took effect). We also constrain
// blob1 (action) to the set of real repo actions, so stale rows from a
// previous bug where /admin/stats parsed as owner=admin, repo=stats
// don't pollute the popular list. Keep this list in sync with ACTIONS
// in worker.ts. Status >= '400' captures all 4xx/5xx — string compare
// is fine for three-digit codes.
const REPO_ACTIONS_SQL = `('tree', 'tree.json', 'file', 'files', 'stat', 'outline', 'symbol', 'grep', 'bash', 'head', 'status')`;

export async function fetchTopRepos(env: AnalyticsEnv, window: Window, limit = 50): Promise<RepoRow[]> {
  return cached("top-repos", window, limit, 60, async () => {
    const interval = windowToInterval(window);
    const rows = await sql<{
      owner: string; repo: string; requests: string;
      errors: string; p50: string; p95: string;
    }>(env, `
      SELECT
        blob4 AS owner,
        blob5 AS repo,
        SUM(_sample_interval) AS requests,
        SUM(if(blob3 >= '400', _sample_interval, 0)) AS errors,
        quantileWeighted(0.50)(double1, _sample_interval) AS p50,
        quantileWeighted(0.95)(double1, _sample_interval) AS p95
      FROM ${DATASET}
      WHERE timestamp > NOW() - ${interval}
        AND blob4 != '-' AND blob4 != ''
        AND blob1 IN ${REPO_ACTIONS_SQL}
      GROUP BY owner, repo
      ORDER BY requests DESC
      LIMIT ${limit}
    `);
    return rows.map(r => {
      const total = n(r.requests);
      return {
        owner: r.owner,
        repo: r.repo,
        requests: total,
        errorRate: total > 0 ? n(r.errors) / total : 0,
        p50Ms: Math.round(n(r.p50)),
        p95Ms: Math.round(n(r.p95)),
      };
    });
  });
}

async function fetchByAction(env: AnalyticsEnv, window: Window): Promise<(ActionRow & { p99Ms: number })[]> {
  const interval = windowToInterval(window);
  const rows = await sql<{ action: string; requests: string; p50: string; p95: string; p99: string }>(env, `
    SELECT
      blob1 AS action,
      SUM(_sample_interval) AS requests,
      quantileWeighted(0.50)(double1, _sample_interval) AS p50,
      quantileWeighted(0.95)(double1, _sample_interval) AS p95,
      quantileWeighted(0.99)(double1, _sample_interval) AS p99
    FROM ${DATASET}
    WHERE timestamp > NOW() - ${interval}
    GROUP BY action
    ORDER BY requests DESC
    LIMIT 50
  `);
  return rows.map(r => ({
    action: r.action,
    requests: n(r.requests),
    p50Ms: Math.round(n(r.p50)),
    p95Ms: Math.round(n(r.p95)),
    p99Ms: Math.round(n(r.p99)),
  }));
}

async function fetchTopErrors(env: AnalyticsEnv, window: Window, limit = 30): Promise<ErrorGroup[]> {
  const interval = windowToInterval(window);
  const rows = await sql<{
    status: string; action: string; owner: string; repo: string;
    requests: string; p95: string;
  }>(env, `
    SELECT blob3 AS status, blob1 AS action, blob4 AS owner, blob5 AS repo,
           SUM(_sample_interval) AS requests,
           quantileWeighted(0.95)(double1, _sample_interval) AS p95
    FROM ${DATASET}
    WHERE timestamp > NOW() - ${interval} AND blob3 >= '400'
    GROUP BY status, action, owner, repo
    ORDER BY requests DESC
    LIMIT ${limit}
  `);
  return rows.map(r => ({
    status: r.status,
    action: r.action,
    owner: r.owner,
    repo: r.repo,
    requests: n(r.requests),
    p95Ms: Math.round(n(r.p95)),
  }));
}

async function fetchByStatus(env: AnalyticsEnv, window: Window): Promise<StatusRow[]> {
  const interval = windowToInterval(window);
  const rows = await sql<{ status: string; requests: string }>(env, `
    SELECT blob3 AS status, SUM(_sample_interval) AS requests
    FROM ${DATASET}
    WHERE timestamp > NOW() - ${interval}
    GROUP BY status
    ORDER BY requests DESC
    LIMIT 20
  `);
  return rows.map(r => ({ status: r.status, requests: n(r.requests) }));
}

async function fetchTotals(env: AnalyticsEnv, window: Window): Promise<{
  total: number; errors: number; p50: number; p95: number; p99: number; edgeHits: number;
}> {
  const interval = windowToInterval(window);
  const rows = await sql<{
    requests: string; errors: string;
    p50: string; p95: string; p99: string; edge: string;
  }>(env, `
    SELECT
      SUM(_sample_interval) AS requests,
      SUM(if(blob3 >= '400', _sample_interval, 0)) AS errors,
      SUM(if(blob2 = 'edge', _sample_interval, 0)) AS edge,
      quantileWeighted(0.50)(double1, _sample_interval) AS p50,
      quantileWeighted(0.95)(double1, _sample_interval) AS p95,
      quantileWeighted(0.99)(double1, _sample_interval) AS p99
    FROM ${DATASET}
    WHERE timestamp > NOW() - ${interval}
  `);
  const r = rows[0] ?? { requests: "0", errors: "0", p50: "0", p95: "0", p99: "0", edge: "0" };
  return {
    total: n(r.requests),
    errors: n(r.errors),
    edgeHits: n(r.edge),
    p50: Math.round(n(r.p50)),
    p95: Math.round(n(r.p95)),
    p99: Math.round(n(r.p99)),
  };
}

async function fetchUniqueRepos(env: AnalyticsEnv, window: Window): Promise<number> {
  // AE SQL has no uniqExact / count(distinct) — we GROUP BY and count rows
  // in JS. Cardinality of unique (owner, repo) is bounded by how many repos
  // ever get touched, which is small enough to ship across the wire.
  const interval = windowToInterval(window);
  const rows = await sql<{ owner: string; repo: string }>(env, `
    SELECT blob4 AS owner, blob5 AS repo
    FROM ${DATASET}
    WHERE timestamp > NOW() - ${interval}
      AND blob4 != '-' AND blob4 != ''
      AND blob1 IN ${REPO_ACTIONS_SQL}
    GROUP BY owner, repo
    LIMIT 10000
  `);
  return rows.length;
}

async function fetchFleetTimeSeries(env: AnalyticsEnv, window: Window): Promise<TimeSeriesPoint[]> {
  const interval = windowToInterval(window);
  // For short windows show 5-min buckets, for longer windows show hourly.
  const bucket = (window === "1h") ? "toStartOfFiveMinutes(timestamp)" : "toStartOfHour(timestamp)";
  const rows = await sql<{ hour: string; requests: string; p95: string; errors: string }>(env, `
    SELECT ${bucket} AS hour,
           SUM(_sample_interval) AS requests,
           quantileWeighted(0.95)(double1, _sample_interval) AS p95,
           SUM(if(blob3 >= '400', _sample_interval, 0)) AS errors
    FROM ${DATASET}
    WHERE timestamp > NOW() - ${interval}
    GROUP BY hour ORDER BY hour
  `);
  return rows.map(r => ({
    hour: r.hour, requests: n(r.requests),
    p95Ms: Math.round(n(r.p95)), errors: n(r.errors),
  }));
}

async function fetchByClient(env: AnalyticsEnv, window: Window): Promise<ClientRow[]> {
  const interval = windowToInterval(window);
  const rows = await sql<{
    client: string; requests: string; errors: string;
    p50: string; p95: string;
  }>(env, `
    SELECT blob7 AS client,
           SUM(_sample_interval) AS requests,
           SUM(if(blob3 >= '400', _sample_interval, 0)) AS errors,
           quantileWeighted(0.50)(double1, _sample_interval) AS p50,
           quantileWeighted(0.95)(double1, _sample_interval) AS p95
    FROM ${DATASET}
    WHERE timestamp > NOW() - ${interval}
      AND blob1 IN ${REPO_ACTIONS_SQL}
    GROUP BY client ORDER BY requests DESC LIMIT 30
  `);
  // Pull unique-repo counts per client in a second pass — we have to
  // GROUP BY and count in JS because AE has no count(distinct).
  const repoRows = await sql<{ client: string; owner: string; repo: string }>(env, `
    SELECT blob7 AS client, blob4 AS owner, blob5 AS repo
    FROM ${DATASET}
    WHERE timestamp > NOW() - ${interval}
      AND blob1 IN ${REPO_ACTIONS_SQL}
      AND blob4 != '-' AND blob4 != ''
    GROUP BY client, owner, repo LIMIT 10000
  `);
  const uniqByClient = new Map<string, number>();
  for (const r of repoRows) uniqByClient.set(r.client, (uniqByClient.get(r.client) ?? 0) + 1);
  return rows.map(r => {
    const total = n(r.requests);
    return {
      client: r.client || "unknown",
      requests: total,
      errorRate: total > 0 ? n(r.errors) / total : 0,
      p50Ms: Math.round(n(r.p50)),
      p95Ms: Math.round(n(r.p95)),
      uniqueRepos: uniqByClient.get(r.client) ?? 0,
    };
  });
}

async function fetchSlowRequests(env: AnalyticsEnv, window: Window, thresholdMs = 5000, limit = 25): Promise<SlowRequestGroup[]> {
  const interval = windowToInterval(window);
  // HAVING isn't supported in AE SQL, so we filter slow > 0 in JS after fetch.
  const rows = await sql<{
    action: string; owner: string; repo: string; client: string;
    slow_count: string; total: string; p95: string; p99: string;
  }>(env, `
    SELECT blob1 AS action, blob4 AS owner, blob5 AS repo, blob7 AS client,
           SUM(if(double1 > ${thresholdMs}, _sample_interval, 0)) AS slow_count,
           SUM(_sample_interval) AS total,
           quantileWeighted(0.95)(double1, _sample_interval) AS p95,
           quantileWeighted(0.99)(double1, _sample_interval) AS p99
    FROM ${DATASET}
    WHERE timestamp > NOW() - ${interval}
      AND blob1 IN ${REPO_ACTIONS_SQL}
      AND blob4 != '-' AND blob4 != ''
    GROUP BY action, owner, repo, client
    ORDER BY slow_count DESC
    LIMIT ${limit * 4}
  `);
  return rows
    .map(r => ({
      action: r.action, owner: r.owner, repo: r.repo,
      client: r.client || "unknown",
      slowCount: n(r.slow_count),
      total: n(r.total),
      p95Ms: Math.round(n(r.p95)),
      p99Ms: Math.round(n(r.p99)),
    }))
    .filter(r => r.slowCount > 0)
    .slice(0, limit);
}

async function fetchRecentFailures(env: AnalyticsEnv, window: Window, limit = 50): Promise<FailureRow[]> {
  const interval = windowToInterval(window);
  // AE has no raw-row SELECT, so we bucket at minute granularity. Each row
  // is "in minute X, there were N requests for path P that returned status
  // S". For low-traffic failures (~most cases), N=1 and minute granularity
  // is fine for a "copy these into an agent" workflow.
  const rows = await sql<{
    minute: string; status: string; action: string;
    owner: string; repo: string; client: string; path: string;
    count: string; p95: string;
  }>(env, `
    SELECT toStartOfMinute(timestamp) AS minute,
           blob3 AS status, blob1 AS action,
           blob4 AS owner, blob5 AS repo, blob7 AS client, blob8 AS path,
           SUM(_sample_interval) AS count,
           quantileWeighted(0.95)(double1, _sample_interval) AS p95
    FROM ${DATASET}
    WHERE timestamp > NOW() - ${interval} AND blob3 >= '400'
    GROUP BY minute, status, action, owner, repo, client, path
    ORDER BY minute DESC
    LIMIT ${limit}
  `);
  return rows.map(r => ({
    minute: r.minute, status: r.status, action: r.action,
    owner: r.owner, repo: r.repo,
    client: r.client || "unknown",
    path: r.path || "(no path)",
    count: n(r.count),
    p95Ms: Math.round(n(r.p95)),
  }));
}

async function fetchIngestFailures(env: AnalyticsEnv, window: Window): Promise<{ owner: string; repo: string; reason: string; count: number }[]> {
  // The worker writes a separate AE row on ingest failure with
  // blob1='ingest_failure', blob2='<owner>/<repo>', blob3='<reason>'.
  // This is a different schema from the per-request rows.
  const interval = windowToInterval(window);
  const rows = await sql<{ slug: string; reason: string; count: string }>(env, `
    SELECT blob2 AS slug, blob3 AS reason, SUM(_sample_interval) AS count
    FROM ${DATASET}
    WHERE timestamp > NOW() - ${interval} AND blob1 = 'ingest_failure'
    GROUP BY slug, reason ORDER BY count DESC LIMIT 25
  `);
  return rows.map(r => {
    const [owner = "?", repo = "?"] = (r.slug || "").split("/");
    return { owner, repo, reason: r.reason, count: n(r.count) };
  });
}

// ----- Per-repo drill-down ------------------------------------------------

export interface LatencyBucket {
  bucket: string;       // e.g. "<50ms"
  bucketOrder: number;  // for sort
  requests: number;
}

export interface TimeSeriesPoint {
  hour: string;         // ISO
  requests: number;
  p95Ms: number;
  errors: number;
}

export interface RepoDetail {
  owner: string;
  repo: string;
  window: Window;
  generatedAt: string;
  totals: { requests: number; errors: number; p50Ms: number; p95Ms: number; p99Ms: number };
  byAction: ActionRow[];
  byStatus: StatusRow[];
  bySource: { source: string; requests: number; p50Ms: number; p95Ms: number }[];
  byRefKind: { refKind: string; requests: number }[];
  latencyHistogram: LatencyBucket[];
  timeSeries: TimeSeriesPoint[];
  errorGroups: { status: string; action: string; requests: number; p95Ms: number }[];
}

// Escape a single value for embedding in a SQL string literal. AE SQL
// doesn't support parameterised queries — we hand-escape. Owner/repo are
// already validated as /^[\w.-]+$/ in the worker before this is called,
// but defensive escaping is cheap.
function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''").replace(/\\/g, "\\\\")}'`;
}

export async function fetchRepoDetail(env: AnalyticsEnv, window: Window, owner: string, repo: string): Promise<RepoDetail> {
  // Cache key includes owner/repo via a synthetic suffix in `limit`.
  // We hash the slug into a stable bucket integer; collisions are
  // harmless (just stale-by-60s).
  const slugHash = Math.abs([...`${owner}/${repo}`].reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0));
  return cached(`repo:${owner}/${repo}`, window, slugHash, 60, async () => {
    const interval = windowToInterval(window);
    const ownerLit = sqlStr(owner);
    const repoLit = sqlStr(repo);
    const where = `WHERE timestamp > NOW() - ${interval} AND blob4 = ${ownerLit} AND blob5 = ${repoLit} AND blob1 IN ${REPO_ACTIONS_SQL}`;

    const [totalsRows, actionsRows, statusRows, sourceRows, refRows, histRows, tsRows, errRows] = await Promise.all([
      sql<{ requests: string; errors: string; p50: string; p95: string; p99: string }>(env, `
        SELECT SUM(_sample_interval) AS requests,
               SUM(if(blob3 >= '400', _sample_interval, 0)) AS errors,
               quantileWeighted(0.50)(double1, _sample_interval) AS p50,
               quantileWeighted(0.95)(double1, _sample_interval) AS p95,
               quantileWeighted(0.99)(double1, _sample_interval) AS p99
        FROM ${DATASET} ${where}
      `),
      sql<{ action: string; requests: string; p50: string; p95: string }>(env, `
        SELECT blob1 AS action,
               SUM(_sample_interval) AS requests,
               quantileWeighted(0.50)(double1, _sample_interval) AS p50,
               quantileWeighted(0.95)(double1, _sample_interval) AS p95
        FROM ${DATASET} ${where}
        GROUP BY action ORDER BY requests DESC LIMIT 30
      `),
      sql<{ status: string; requests: string }>(env, `
        SELECT blob3 AS status, SUM(_sample_interval) AS requests
        FROM ${DATASET} ${where}
        GROUP BY status ORDER BY requests DESC LIMIT 20
      `),
      sql<{ source: string; requests: string; p50: string; p95: string }>(env, `
        SELECT blob2 AS source,
               SUM(_sample_interval) AS requests,
               quantileWeighted(0.50)(double1, _sample_interval) AS p50,
               quantileWeighted(0.95)(double1, _sample_interval) AS p95
        FROM ${DATASET} ${where}
        GROUP BY source ORDER BY requests DESC LIMIT 10
      `),
      sql<{ refKind: string; requests: string }>(env, `
        SELECT blob6 AS refKind, SUM(_sample_interval) AS requests
        FROM ${DATASET} ${where}
        GROUP BY refKind ORDER BY requests DESC LIMIT 10
      `),
      sql<{ bucket: string; bucket_order: string; requests: string }>(env, `
        SELECT
          if(double1 < 50, '<50ms',
            if(double1 < 100, '50-100ms',
              if(double1 < 250, '100-250ms',
                if(double1 < 500, '250-500ms',
                  if(double1 < 1000, '500ms-1s',
                    if(double1 < 2500, '1-2.5s',
                      if(double1 < 5000, '2.5-5s', '5s+'))))))) AS bucket,
          if(double1 < 50, 1,
            if(double1 < 100, 2,
              if(double1 < 250, 3,
                if(double1 < 500, 4,
                  if(double1 < 1000, 5,
                    if(double1 < 2500, 6,
                      if(double1 < 5000, 7, 8))))))) AS bucket_order,
          SUM(_sample_interval) AS requests
        FROM ${DATASET} ${where}
        GROUP BY bucket, bucket_order
        ORDER BY bucket_order
      `),
      sql<{ hour: string; requests: string; p95: string; errors: string }>(env, `
        SELECT toStartOfHour(timestamp) AS hour,
               SUM(_sample_interval) AS requests,
               quantileWeighted(0.95)(double1, _sample_interval) AS p95,
               SUM(if(blob3 >= '400', _sample_interval, 0)) AS errors
        FROM ${DATASET} ${where}
        GROUP BY hour ORDER BY hour
      `),
      sql<{ status: string; action: string; requests: string; p95: string }>(env, `
        SELECT blob3 AS status, blob1 AS action,
               SUM(_sample_interval) AS requests,
               quantileWeighted(0.95)(double1, _sample_interval) AS p95
        FROM ${DATASET} ${where} AND blob3 >= '400'
        GROUP BY status, action ORDER BY requests DESC LIMIT 25
      `),
    ]);

    const t = totalsRows[0] ?? { requests: "0", errors: "0", p50: "0", p95: "0", p99: "0" };
    return {
      owner, repo, window,
      generatedAt: new Date().toISOString(),
      totals: {
        requests: n(t.requests),
        errors: n(t.errors),
        p50Ms: Math.round(n(t.p50)),
        p95Ms: Math.round(n(t.p95)),
        p99Ms: Math.round(n(t.p99)),
      },
      byAction: actionsRows.map(r => ({
        action: r.action, requests: n(r.requests),
        p50Ms: Math.round(n(r.p50)), p95Ms: Math.round(n(r.p95)),
      })),
      byStatus: statusRows.map(r => ({ status: r.status, requests: n(r.requests) })),
      bySource: sourceRows.map(r => ({
        source: r.source || "(unknown)", requests: n(r.requests),
        p50Ms: Math.round(n(r.p50)), p95Ms: Math.round(n(r.p95)),
      })),
      byRefKind: refRows.map(r => ({ refKind: r.refKind || "(none)", requests: n(r.requests) })),
      latencyHistogram: histRows.map(r => ({
        bucket: r.bucket, bucketOrder: Number(r.bucket_order), requests: n(r.requests),
      })),
      timeSeries: tsRows.map(r => ({
        hour: r.hour, requests: n(r.requests),
        p95Ms: Math.round(n(r.p95)), errors: n(r.errors),
      })),
      errorGroups: errRows.map(r => ({
        status: r.status, action: r.action,
        requests: n(r.requests), p95Ms: Math.round(n(r.p95)),
      })),
    };
  });
}

export async function fetchStatsBundle(env: AnalyticsEnv, window: Window): Promise<StatsBundle> {
  return cached("bundle", window, 0, 60, async () => {
    const [totals, byAction, byStatus, byClient, topRepos, topErrors, timeSeries, uniqueRepos, ingestFailures, slowRequests, recentFailures] = await Promise.all([
      fetchTotals(env, window),
      fetchByAction(env, window),
      fetchByStatus(env, window),
      fetchByClient(env, window),
      fetchTopRepos(env, window, 20),
      fetchTopErrors(env, window, 30),
      fetchFleetTimeSeries(env, window),
      fetchUniqueRepos(env, window),
      fetchIngestFailures(env, window),
      fetchSlowRequests(env, window),
      fetchRecentFailures(env, window),
    ]);
    return {
      window,
      generatedAt: new Date().toISOString(),
      totalRequests: totals.total,
      errorRate: totals.total > 0 ? totals.errors / totals.total : 0,
      cacheHitRate: totals.total > 0 ? totals.edgeHits / totals.total : 0,
      p50Ms: totals.p50,
      p95Ms: totals.p95,
      p99Ms: totals.p99,
      uniqueRepos,
      topRepos,
      byAction,
      byStatus,
      byClient,
      topErrors,
      timeSeries,
      ingestFailures,
      slowRequests,
      recentFailures,
    };
  });
}
