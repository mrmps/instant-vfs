import { RepoDO, type Env, type RateLimiterBinding } from "./repo-do";
import { fetchRepoDetail, fetchStatsBundle, fetchTopRepos, isAnalyticsConfigured, type RepoDetail, type Window } from "./analytics";
import { isFullSha, isShortSha, looksLikeTag } from "./github";
import { outline, detectLanguage } from "./outline";
import { normalizeGlob } from "./glob";
import { resolveRefCached } from "./ref-cache";

// Extract the client IP for rate-limit keying. cf-connecting-ip is populated
// by Cloudflare for every request; fall back to "anon" so a missing header
// still maps to *some* bucket (rather than bypassing the limit).
function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "anon";
}

// Constant-time string comparison so timing-based secret probing is useless.
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Does this request bear a valid internal-tooling bypass header? When true,
// we skip the per-IP rate limit layer (but keep per-SHA throttle — that one
// protects us from our own bugs).
function hasInternalBypass(request: Request, env: Env): boolean {
  const expected = env.GITVFS_INTERNAL_KEY;
  if (!expected) return false;
  const presented = request.headers.get("x-gitvfs-key");
  if (!presented) return false;
  return constantTimeEquals(presented, expected);
}

// Consult a rate-limiter binding. Returns a Response if the IP is over its
// quota, or null if the request may proceed. Safe no-op when the binding is
// not configured (dev env, local testing).
async function rateLimit(
  rl: RateLimiterBinding | undefined,
  ip: string,
  kind: string,
): Promise<Response | null> {
  if (!rl) return null;
  const r = await rl.limit({ key: ip });
  if (r.success) return null;
  // We don't know the exact retry window from the binding — these are sliding
  // windows tuned in wrangler.toml — so we surface a generic "a few seconds"
  // retry hint. Burst-heavy agents will quickly learn the cadence.
  return throttled(
    "rate_limited",
    `Per-IP rate limit exceeded on ${kind}. Retry in a few seconds.`,
    5,
    { kind, ip: ip === "anon" ? undefined : "<hidden>" },
  );
}

// Count LF bytes — cheap, no UTF-8 decode. A trailing unterminated line counts.
function countLines(bytes: Uint8Array): number {
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

export { RepoDO };

// Security + ergonomics headers applied to every response. These are safe
// defaults for a read-only service over public repos.
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type, x-gitvfs-key",
};

function corsPreflight(request: Request): Response {
  const requestedHeaders = request.headers.get("access-control-request-headers");
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      ...(requestedHeaders ? { "access-control-allow-headers": requestedHeaders } : {}),
      "access-control-max-age": "86400",
      vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      ...SECURITY_HEADERS,
    },
  });
}

// Every 4xx/5xx error body gets these links. Agents (and humans) hitting an
// unknown endpoint get a direct pointer to the full documentation without
// having to guess the base URL.
const DOCS_URL = "https://gitvfs.miryaboy.workers.dev/";
const LLMS_TXT_URL = "https://gitvfs.miryaboy.workers.dev/llms.txt";

function json(data: unknown, status = 200, extra: HeadersInit = {}) {
  const base: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    ...CORS_HEADERS,
    ...SECURITY_HEADERS,
  };
  const headers = { ...base, ...Object.fromEntries(new Headers(extra)) };
  if (status >= 400) headers["cache-control"] = "no-store";
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers,
  });
}

function text(body: string, status = 200, extra: HeadersInit = {}) {
  const base: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    ...CORS_HEADERS,
    ...SECURITY_HEADERS,
  };
  const headers = { ...base, ...Object.fromEntries(new Headers(extra)) };
  if (status >= 400) headers["cache-control"] = "no-store";
  return new Response(body, {
    status,
    headers,
  });
}

function err(
  code: string,
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
  headers: HeadersInit = {},
) {
  return json(
    { error: code, message, ...extra, docs: DOCS_URL, llms_txt: LLMS_TXT_URL },
    status, headers,
  );
}

// 429 with retry-after — unified for throttle + upstream rate-limits.
function throttled(
  code: string,
  message: string,
  retryAfterSec: number,
  extra: Record<string, unknown> = {},
) {
  return err(code, message, 429, extra, {
    "retry-after": String(Math.max(1, Math.floor(retryAfterSec))),
  });
}

// Read & validate `?path=` query parameter. Agents reach for this by analogy
// with `grep pattern path/`, `find path/`, `ls path/`, `tree path/`. Prior
// versions swallowed the param; the 30-agent study showed ~20/28 agents tried
// it. Return `{ path }` on valid input, an error Response on rejection, or
// `null` when absent.
function readPathParam(url: URL): { path: string } | Response | null {
  const raw = url.searchParams.get("path");
  if (raw === null) return null;
  if (raw === "") {
    return json({
      error: "bad_path_param",
      message: "?path= cannot be empty.",
      hint: "Pass a file or directory path under the repo, e.g. ?path=src/index.ts",
    }, 400);
  }
  // Normalize leading/trailing slashes. Reject traversal and obviously-bogus input.
  const normalized = raw.replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.length > MAX_PATH_LENGTH) {
    return json({
      error: "bad_path_param",
      message: "?path= is empty after normalization or too long.",
      got: raw,
    }, 400);
  }
  for (const seg of normalized.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      return json({
        error: "bad_path_param",
        message: "?path= contains invalid segment (empty / '.' / '..').",
        got: raw,
      }, 400);
    }
  }
  return { path: normalized };
}

// Hint-rich bad_path response. Every 30-agent trace showed that the default
// `bad_path` error burns 2–3 calls while the agent guesses URL shapes.
// Embedding expected/example/got makes the error self-correcting.
function badPath(got: string, message?: string) {
  return json(
    {
      error: "bad_path",
      message: message ?? "URL must start with /:owner/:repo.",
      expected: "/:owner/:repo[@:ref]/<action>[/<path>]",
      example: "/facebook/react/tree   or   /honojs/hono/grep?q=middleware",
      got,
      actions: ["tree", "tree.json", "file", "stat", "outline", "grep", "head", "status", "bash", "files"],
      docs: DOCS_URL,
      llms_txt: LLMS_TXT_URL,
    },
    400,
  );
}

interface ParsedRepo {
  owner: string;
  repo: string;
  ref: string | null;
  rest: string[];
}

const ACTIONS = new Set([
  "tree", "tree.json", "file", "files", "stat", "grep", "status",
  "outline", "symbol", "count", "head", "bash",
]);

// Validate a file path coming from user input (query params).
function isValidFilePath(p: string): boolean {
  if (!p) return false;
  if (p.length > MAX_PATH_LENGTH) return false;
  // Strip a possible leading slash before segment-checking.
  const trimmed = p.replace(/^\/+/, "");
  const segs = trimmed.split("/");
  if (segs.length === 0 || segs.length > MAX_PATH_SEGMENTS) return false;
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return false;
    if (s.length > 255) return false;
  }
  return true;
}

// Reject path components that could be traversal or absurdly deep.
const MAX_PATH_SEGMENTS = 48;
const MAX_PATH_LENGTH = 2048;

function isValidPathSegment(s: string): boolean {
  if (s === "" || s === "." || s === "..") return false;
  if (s.length > 255) return false;
  return true;
}

function parsePath(pathname: string): ParsedRepo | null {
  if (pathname.length > MAX_PATH_LENGTH) return null;
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length === 0 || segs.length > MAX_PATH_SEGMENTS) return null;
  let i = 0;
  const fromGitHubUrl = segs[0] === "github.com";
  if (fromGitHubUrl) i++;
  if (segs.length - i < 2) return null;
  const owner = segs[i];
  let repoAndRef = segs[i + 1];
  if (repoAndRef.endsWith(".git")) repoAndRef = repoAndRef.slice(0, -4);
  let repo = repoAndRef;
  let ref: string | null = null;
  const at = repoAndRef.indexOf("@");
  if (at >= 0) {
    repo = repoAndRef.slice(0, at);
    ref = repoAndRef.slice(at + 1);
  }
  if (!owner || !repo) return null;
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;

  let rest = segs.slice(i + 2);
  if (fromGitHubUrl && (rest[0] === "tree" || rest[0] === "blob") && rest.length >= 2) {
    const isBlob = rest[0] === "blob";
    if (!ref) ref = rest[1];
    rest = rest.slice(2);
    if (isBlob && rest.length > 0 && !ACTIONS.has(rest[0])) {
      rest = ["file", ...rest];
    }
  }
  // Path-traversal guard on every remaining segment.
  for (const s of rest) {
    if (!isValidPathSegment(s)) return null;
  }
  return { owner, repo, ref, rest };
}

// Agent-facing catalog. Short, dense, machine-friendly. Served at
// /llms.txt and /.well-known/llms.txt for discovery.
function llmsTxt(host: string): string {
  return `# gitvfs

gitvfs exposes any public GitHub repo as a read-only HTTP VFS.
Base URL: ${host}
Path scheme: /<owner>/<repo>[@<ref>]/<action>[/<path>]
Ref: branch, tag, or 40-char SHA. Omitted = default branch.

## For agents

Use curl or any raw HTTP client. Do NOT use summarizing fetchers — they will
paraphrase source code instead of returning it. Every response carries
x-gitvfs-sha / x-gitvfs-ref / x-gitvfs-resolved-at headers for freshness.

Prefer structured endpoints for exploration:
- For "what line is symbol X on?" / "where is foo defined?" → /outline or /symbol
  (they return line numbers directly; do NOT slice /file and count newlines).
- For file contents → /file?lines=A-B&numbered=1 (numbers prefixed per line).
- For search → /grep (add ?symbols=1 to get enclosing function/class names).
- For batched reads → /files.
- /bash is an escape hatch for ad-hoc multi-step shell pipelines (read-only).
  Shell exit code 0 returns HTTP 200. Non-zero exits return non-2xx
  (400 for unknown commands, 422 for command failures, 504 for timeout)
  and always include x-gitvfs-exit-code.

## Endpoints

- GET /tree[/<path>]?glob=&sizes=1&depth=1&count=1          newline paths
- GET /tree.json[/<path>]?outlines=1                         structured listing
- GET /outline/<path>?depth=2&comments=1                     symbols + endLine + JSDoc
- GET /outline/<dir>                                         bulk outline for every file under it
- GET /symbol/<path>?name=<sym>                              one symbol's line / endLine / signature
- GET /grep?q=<pat>&glob=&exclude_glob=&regex=1&files_only=1&symbols=1 ripgrep-like
- GET /file/<path>?lines=A-B&numbered=1                      raw bytes (slicing + optional N | prefix)
- GET /files?paths=a&paths=b&format=ndjson                   batched reads
- GET /stat/<path>                                           {size, mime, lines, language}
- GET /bash?cmd=<script>&format=text                         read-only shell
- GET /head                                                  freshness probe, no ingest
- GET /status                                                ingest state

## Response headers

x-gitvfs-sha           commit served
x-gitvfs-ref           ref you asked for
x-gitvfs-resolved-at   ISO timestamp of ref→sha resolution
x-gitvfs-age-seconds   staleness (now − resolved)
x-gitvfs-pinned        true when URL pins a full SHA (immutable cache)
x-gitvfs-pin-hint      URL you can use to pin this exact commit
x-gitvfs-lines         logical file line count (trailing final LF is not a blank line)
x-gitvfs-language      detected language
x-gitvfs-exit-code     (/bash only)
x-gitvfs-duration-ms   (/bash only)
x-gitvfs-source        "edge" if served from CF colo cache
x-gitvfs-truncated     true when results were capped

## Caching

- Full-SHA URLs: immutable, cache forever.
- Tag-like refs (vX.Y.Z): 24h + SWR 7d.
- Branches and default ref: 5m + SWR 1h.
- ?refresh=1 forces ref re-resolution; /head is a cheap freshness probe.

## Limits

- Per-IP: 100/10s burst, 200/60s sustained.
- /bash + /grep: 30/10s per IP (CPU-heavy). /bash timeout: 3s default, 5s max.
- Global ingest cap: 30 new repos/min. Max 250MB compressed tarball.

## Examples

curl ${host}/facebook/react/tree.json/packages/react/src?outlines=1
curl ${host}/tj/commander.js/outline/typings/index.d.ts?depth=2&comments=1
curl '${host}/facebook/react/grep?q=useEffect&files_only=1'
curl '${host}/sindresorhus/ky/files?paths=source/index.ts&paths=package.json'
curl --get '${host}/pingdotgg/t3code/bash?format=text' \\
     --data-urlencode 'cmd=grep -rln handleSessionUpdate apps/server/src'
`;
}

function landing(host: string): string {
  return `# gitvfs — instant HTTP VFS over any public GitHub repo

Replace \`github.com\` with this host and curl it.

Agents: fetch ${host}/llms.txt for a compact, machine-friendly catalog.
Browse: ${host}/popular for the most-requested repos.

STOP — read this first (agents)

  Before using gitvfs, fetch THIS landing page in full via raw curl:

      curl ${host}/

  Why: summarizing fetchers (Claude Code's WebFetch, ChatGPT browsing,
  most LLM "fetch URL" tools) pipe the page through a model that
  paraphrases it. The paraphrase looks correct but silently rewrites
  literal query-parameter names into generic words — e.g. ?q= becomes
  "pattern", ?glob= becomes "filter", ?lines= becomes "range". Calls
  built from the summary then 400 with missing_q / bad_glob / etc.

  Verification: the LAST LINE of the real landing page is exactly:

      [END OF gitvfs LANDING PAGE — sha256: see x-gitvfs-doc-sha header]

  If you don't see that exact sentinel at the end of what you fetched,
  you received a summary, not the source. Refetch with raw curl.

  Quick check from a shell:
      curl -s ${host}/ | tail -1
      # expect: [END OF gitvfs LANDING PAGE ...]

For agents

  Use curl (or any raw HTTP client) — not a summarizing fetcher.
  gitvfs also ships extra context via response headers (line counts,
  language, SHA, freshness) that only survive in a raw HTTP response.

  Rule of thumb:
    · exploring / reading code        → curl
    · looking up a single fact       → a summarizing fetch is ok
    · any agent pipeline             → curl, always

Endpoints

  GET /:owner/:repo[@:ref]/tree[/:subpath]
       ?glob=src/**/*.ts                     path filter (SQL GLOB)
       ?sizes=1                              append TAB size (and TAB lines) per line
       ?count=1                              return just the count
       ?depth=1                              one-level listing (dirs shown with /)

  GET /:owner/:repo[@:ref]/tree.json[/:subpath]
       ?outlines=1                           each entry includes language, lines,
                                              top-level symbols and imports
                                              (one round-trip planning view)

  GET /:owner/:repo[@:ref]/file/<path>       raw bytes
       ?lines=10-50                          slice line range
       ?lines=42                              single line

  GET /:owner/:repo[@:ref]/files?paths=a&paths=b[,c]
       &format=ndjson                        one JSON obj per line (stream-friendly)
    Batched read — up to 50 files in one request.
    Missing paths come back as {path, error: "not_found"}.

  GET /:owner/:repo[@:ref]/stat/<path>       {path, size, mime, lines, language}

  GET /:owner/:repo[@:ref]/outline/<path>    exports, symbols, imports, line counts
       ?depth=2                              enumerate class/interface members
       ?comments=1                           include leading JSDoc / // / # comments
       path may be a directory → bulk outline for every file under it
       (items include start+end line numbers when detectable)

  GET /:owner/:repo[@:ref]/grep?q=<pattern>
       &glob=packages/**/*.ts                include scope
       &exclude_glob=**/*.test.ts            drop scope (repeatable)
       &case=i                               case-insensitive
       &regex=1                              q is a regex
       &word=1                               word-boundary match
       &context=2                            ±N lines per match
       &limit=200                            cap (max 10000)
       &files_only=1                         rg -l semantics (shape overrides format=text)
       &format=text                          grep-style path:line:text
       note: regex chars like |,(,)  should be URL-encoded — use
         curl --get --data-urlencode 'q=...'

  GET /:owner/:repo[@:ref]/bash?cmd=<script>
       &format=text                          plain stdout (default is JSON)
       &timeout_ms=3000                      cap wall-clock (default 3000, max 5000)
    Runs a read-only shell pipeline against the repo. Supports:
      echo, ls, cat, head, tail, wc, grep, find, sort, uniq, sed
    Pipelines with '|' work. Variables, redirections, loops, writes,
    and network are not supported. Per-IP cap: 30 req / 10 s.
    Exit 0 returns HTTP 200. Non-zero exits return 400/422/504 and
    include x-gitvfs-exit-code.

  GET /:owner/:repo[@:ref]/head              cheap probe: {sha, resolvedAt, pinned}
  GET /:owner/:repo[@:ref]/status            ingest state
  GET /:owner/:repo[@:ref]                   → /tree

Response metadata (headers on every response)

  x-gitvfs-sha             commit this response came from
  x-gitvfs-ref             ref you asked for (branch/tag/sha)
  x-gitvfs-pinned          true if URL pins a full SHA
  x-gitvfs-resolved-at     when we last asked GitHub for the ref→SHA mapping
  x-gitvfs-age-seconds     now - resolved_at
  x-gitvfs-pin-hint        URL you can use to pin this exact commit forever
  x-gitvfs-source          "edge" if served from CF colo cache, absent otherwise

  On /file responses additionally:
    x-gitvfs-lines         logical line count; trailing final LF is not a blank line
    x-gitvfs-language      detected language (typescript, go, python, …)
    x-gitvfs-total-lines   present on ?lines=… slices so you know the full size
    x-gitvfs-line-range    the effective range you got back

  /file?lines=… past EOF returns 416 line_range_not_satisfiable rather
  than a phantom blank line.

  On /tree responses with ?outlines=1:
    x-gitvfs-truncated     true if entry count exceeded the per-request cap

  Ref→SHA is cached for 24h. Force re-resolution with ?refresh=1.
  Or use /head first to decide if a refresh is worth the ingest cost.

Examples

  curl ${host}/facebook/react/tree/packages/react/src?sizes=1
  curl '${host}/facebook/react/tree.json/packages/react/src?outlines=1'
  curl ${host}/facebook/react/outline/packages/react/src/ReactHooks.js
  curl '${host}/facebook/react/grep?q=useEffect&files_only=1&glob=packages/**/*.js'
  curl '${host}/facebook/react/grep?q=foo&exclude_glob=**/*.test.*&exclude_glob=docs/**'
  curl '${host}/facebook/react/file/packages/react/src/ReactHooks.js?lines=60-75'
  curl -I ${host}/facebook/react/file/packages/react/src/ReactHooks.js   # headers only
  curl ${host}/facebook/react@v18.2.0/tree

  # bash endpoint: feels like a local terminal over the repo
  curl --get '${host}/facebook/react/bash' --data-urlencode 'cmd=ls packages/react/src | head'
  curl --get '${host}/facebook/react/bash?format=text' --data-urlencode 'cmd=grep -rln useEffect packages/react/src | head'
  curl --get '${host}/facebook/react/bash?format=text' --data-urlencode 'cmd=sed -n "60,75p" packages/react/src/ReactHooks.js'

Limits

  · Per-IP burst:        100 requests / 10 s
  · Per-IP sustained:    200 requests / 60 s
  · /bash + /grep:        30 requests / 10 s per IP (CPU-heavy)
  · Bash timeout:         default 3 s, max 5 s wall-clock
  · New-repo ingests:     30 / min globally
  · Max repo size:        250 MB compressed tarball

Notes

  · First request for a repo takes a few seconds (tarball ingest); cached after.
  · Source only — binaries, node_modules, lockfiles, build output skipped.
  · Ref = branch, tag, or full 40-char SHA. Default = default branch.
  · Short SHAs are resolved against GitHub; only full SHAs get long-term cache.
  · Very large repos (>~50k files or >250MB) won't ingest — see limits above.

[END OF gitvfs LANDING PAGE — sha256: see x-gitvfs-doc-sha header]
`;
}

function cacheControlFor(refIsFullSha: boolean, refIsTagLike: boolean): string {
  if (refIsFullSha) return "public, max-age=31536000, immutable";
  if (refIsTagLike) return "public, max-age=86400, stale-while-revalidate=604800";
  // Branches & default: cache 5 minutes + serve stale for 1h while we refresh.
  return "public, max-age=300, stale-while-revalidate=3600";
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = performance.now();
    const url = new URL(request.url);
    const pathname = (() => {
      try { return decodeURIComponent(url.pathname); } catch { return url.pathname; }
    })();

    let resp: Response;
    const bypass = hasInternalBypass(request, env);
    try {
      // Cheap global per-IP gate — catches obvious flooders before we do
      // any work. Expensive endpoints (/bash, /grep) ALSO get a stricter
      // check later, so cheap endpoints stay cheap. Internal tooling with
      // the X-Gitvfs-Key bypass header skips this layer entirely.
      // Two-tier per-IP gate: burst (RL_GENERAL, 100/10s) catches floods,
      // sustained (RL_SUSTAINED, 200/60s) catches steady drainers. Both
      // bypassed for internal-key traffic. Either one tripping = 429.
      if (request.method === "OPTIONS") {
        resp = corsPreflight(request);
      } else {
        let block: Response | null = null;
        if (!bypass) {
          block = await rateLimit(env.RL_GENERAL, clientIp(request), "general");
          if (!block) block = await rateLimit(env.RL_SUSTAINED, clientIp(request), "sustained");
        }
        resp = block ?? await handle(request, env, ctx, url, pathname, bypass);
      }
    } catch (e: any) {
      // Any uncaught exception surfaces as a structured 500 rather than
      // Cloudflare's generic error page — keeps API consumers predictable.
      console.log(JSON.stringify({
        t: new Date().toISOString(),
        level: "error",
        path: pathname,
        error: e?.message ?? String(e),
        stack: e?.stack,
      }));
      resp = err("internal_error", "An unexpected error occurred.", 500);
    }

    // Add request-scoped headers. We clone so we don't mutate a response
    // that's already been handed to the edge cache.
    const durationMs = Math.round(performance.now() - started);
    const out = new Response(resp.body, resp);
    out.headers.set("x-gitvfs-duration-ms", String(durationMs));
    // (security headers are already on responses via json()/text(); this is a
    //  belt-and-suspenders catch for responses built by other code paths)
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (!out.headers.has(k)) out.headers.set(k, v);
    }

    // Coarse endpoint bucket for metrics — stable regardless of repo so
    // Analytics Engine doesn't fan out into high-cardinality keys.
    const action = endpointBucket(pathname);
    const source = out.headers.get("x-gitvfs-source") ?? "do";

    // Structured access log — one JSON line per request for Logpush / tail.
    try {
      console.log(JSON.stringify({
        t: new Date().toISOString(),
        method: request.method,
        path: pathname,
        query: url.search || undefined,
        status: out.status,
        durationMs,
        source,
        sha: out.headers.get("x-gitvfs-sha") ?? undefined,
        exit: out.headers.get("x-gitvfs-exit-code") ?? undefined,
        cf: (request as any).cf?.colo,
      }));
    } catch {
      // logging must never break a response
    }

    // Analytics Engine data point. Fire-and-forget — writeDataPoint is
    // synchronous but very cheap. Safe no-op when METRICS isn't bound.
    // Schema: blob1=action, blob2=source, blob3=status, blob4=owner,
    //         blob5=repo, blob6=refKind, blob7=client, blob8=path,
    //         double1=durationMs, index1=action.
    // - owner/repo power /popular and the per-repo drill-down
    // - client answers "which agents are doing this" (claude-code, chatgpt,
    //   perplexity, cursor, copilot, ...) — see classifyClient()
    // - path is the truncated pathname+query, used by the failures list
    //   so operators can copy the exact failing URLs into an agent to fix
    if (env.METRICS) {
      try {
        const { owner: ownerForMetric, repo: repoForMetric, refKind } = repoFromPath(pathname);
        const client = classifyClient(request.headers.get("user-agent"));
        const pathTrunc = pathBucket(pathname, url.search);
        env.METRICS.writeDataPoint({
          blobs: [action, source, String(out.status), ownerForMetric, repoForMetric, refKind, client, pathTrunc],
          doubles: [durationMs],
          indexes: [action],
        });
      } catch {}
    }

    return out;
  },
};

// -------------------------------------------------------------------------
// Observability routes
// -------------------------------------------------------------------------
//
// /popular         — public list of most-requested repos (deepwiki-style).
// /admin/stats     — JSON: totals, error rate, p50/p95, top repos, by-action.
// /admin/dashboard — HTML rendering of /admin/stats.
//
// Both /admin/* routes require the X-Gitvfs-Key header OR a matching
// ?key=... query param so a browser can reach the dashboard. The popular
// list is public; per-repo request counts are observable from outside
// anyway (anyone can call /<owner>/<repo>/head) and this just makes the
// aggregate friendlier to browse.

function parseWindow(s: string | null): Window {
  if (s === "1h" || s === "24h" || s === "7d" || s === "30d") return s;
  return "24h";
}

async function handlePopular(env: Env, url: URL): Promise<Response> {
  if (!isAnalyticsConfigured(env)) {
    return text(
      "Popular repos page is unavailable until CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN are configured.\n",
      503,
    );
  }
  // Default to 7d — "popular" is a long-horizon question; 24h was too
  // narrow and would render empty during quiet periods.
  const rawWindow = url.searchParams.get("window");
  const window = rawWindow ? parseWindow(rawWindow) : "7d";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 200);
  try {
    const repos = await fetchTopRepos(env, window, limit);
    if (url.searchParams.get("format") === "json") {
      return json({ window, repos });
    }
    return html(renderPopular(url.origin, window, repos), 200, {
      "cache-control": "public, max-age=60, stale-while-revalidate=300",
    });
  } catch (e: any) {
    return text(`analytics_error: ${e?.message ?? String(e)}\n`, 502);
  }
}

async function handleAdminStats(env: Env, url: URL): Promise<Response> {
  if (!isAnalyticsConfigured(env)) {
    return err("analytics_not_configured", "Set CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN.", 503);
  }
  const window = parseWindow(url.searchParams.get("window"));
  try {
    const bundle = await fetchStatsBundle(env, window);
    return json(bundle);
  } catch (e: any) {
    return err("analytics_error", e?.message ?? String(e), 502);
  }
}

async function handleAdminDashboard(env: Env, url: URL): Promise<Response> {
  if (!isAnalyticsConfigured(env)) {
    return text("Set CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN to enable the dashboard.\n", 503);
  }
  const window = parseWindow(url.searchParams.get("window"));
  try {
    const bundle = await fetchStatsBundle(env, window);
    return html(renderDashboard(url, bundle), 200, {
      "cache-control": "public, max-age=60",
    });
  } catch (e: any) {
    return text(`analytics_error: ${e?.message ?? String(e)}\n`, 502);
  }
}

async function handleAdminRepo(env: Env, url: URL, owner: string, repo: string): Promise<Response> {
  if (!isAnalyticsConfigured(env)) {
    return text("Set CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN to enable repo detail.\n", 503);
  }
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    return err("bad_repo", "Invalid owner/repo.", 400);
  }
  const window = parseWindow(url.searchParams.get("window"));
  try {
    const detail = await fetchRepoDetail(env, window, owner, repo);
    if (url.searchParams.get("format") === "json") return json(detail);
    return html(renderRepoDetail(url, owner, repo, detail), 200, {
      "cache-control": "public, max-age=60",
    });
  } catch (e: any) {
    return text(`analytics_error: ${e?.message ?? String(e)}\n`, 502);
  }
}

// -- HTML rendering --------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

function html(body: string, status = 200, extra: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...CORS_HEADERS,
      ...SECURITY_HEADERS,
      ...Object.fromEntries(new Headers(extra)),
    },
  });
}

const BASE_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 24px; max-width: 980px; margin-inline: auto;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.5; color: #111; background: #fafaf7;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0d0d0c; color: #eee; }
    a { color: #9ecbff; }
    .card { background: #161614; border-color: #2a2a27; }
    .repo { border-color: #2a2a27; }
    .muted { color: #888; }
    code, pre { background: #1a1a17; color: #ddd; }
  }
  h1 { font-size: 28px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 18px; font-weight: 600; margin: 32px 0 12px; }
  p.lede { color: #555; margin: 0 0 32px; font-size: 15px; }
  a { color: #0a6cf1; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .muted { color: #888; font-size: 13px; }
  code, pre {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    background: #f0efea; padding: 1px 5px; border-radius: 3px; font-size: 13px;
  }
  .windowbar { display: flex; gap: 8px; margin: 0 0 24px; flex-wrap: wrap; }
  .windowbar a {
    padding: 4px 10px; border: 1px solid #ddd; border-radius: 999px;
    color: #555; font-size: 13px;
  }
  .windowbar a.on { background: #111; color: #fff; border-color: #111; }
  @media (prefers-color-scheme: dark) {
    .windowbar a { border-color: #333; color: #aaa; }
    .windowbar a.on { background: #eee; color: #111; border-color: #eee; }
  }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 32px; }
  .card { background: #fff; border: 1px solid #e6e3da; border-radius: 10px; padding: 16px 18px; }
  .card .label { font-size: 12px; color: #888; text-transform: uppercase; letter-spacing: 0.04em; }
  .card .value { font-size: 26px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .repo {
    display: flex; align-items: baseline; gap: 16px; padding: 14px 0;
    border-bottom: 1px solid #ece9df;
  }
  .repo:last-child { border-bottom: none; }
  .repo .name { flex: 1; font-size: 15px; }
  .repo .name a { color: inherit; font-weight: 500; }
  .repo .count { font-variant-numeric: tabular-nums; font-weight: 500; }
  .repo .meta { font-size: 12px; color: #888; min-width: 120px; text-align: right; }
  table.kv { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.kv td { padding: 6px 0; border-bottom: 1px solid #ece9df; }
  table.kv td.r { text-align: right; font-variant-numeric: tabular-nums; }
  table.failures td { vertical-align: top; }
  table.failures input[type="checkbox"] { transform: translateY(2px); }
  .failures-toolbar {
    display: flex; align-items: center; gap: 16px; margin: 4px 0 8px;
    font-size: 13px;
  }
  .btn {
    font: inherit; font-size: 13px; padding: 4px 10px;
    border: 1px solid #ccc; background: #fff; border-radius: 6px; cursor: pointer;
  }
  .btn:hover { background: #f4f4ef; }
  @media (prefers-color-scheme: dark) {
    .btn { background: #1a1a17; color: #eee; border-color: #333; }
    .btn:hover { background: #232320; }
  }
  footer { margin-top: 48px; font-size: 12px; color: #888; }
`;

const FAILURES_JS = `
(function(){
  const all = document.getElementById('select-all-failures');
  const checks = document.querySelectorAll('.fcheck');
  const btn = document.getElementById('copy-failures');
  const status = document.getElementById('copy-status');
  if (!btn || !checks.length) return;
  if (all) {
    all.addEventListener('change', () => {
      checks.forEach(c => { c.checked = all.checked; });
    });
  }
  btn.addEventListener('click', async () => {
    const picked = Array.from(checks).filter(c => c.checked);
    const rows = (picked.length ? picked : Array.from(checks));
    if (!rows.length) { if (status) status.textContent = 'nothing to copy'; return; }
    const lines = [
      '## Recent gitvfs failures',
      'These are failures observed against the gitvfs HTTP VFS. Investigate root cause and propose a fix.',
      '',
      '| time (UTC) | status | action | path | client | count |',
      '|---|---|---|---|---|---|',
    ];
    rows.forEach(r => {
      const cells = [
        r.dataset.when, r.dataset.status, r.dataset.action,
        '\`' + r.dataset.path + '\`', r.dataset.client, r.dataset.count,
      ];
      lines.push('| ' + cells.join(' | ') + ' |');
    });
    const text = lines.join('\\n');
    try {
      await navigator.clipboard.writeText(text);
      if (status) status.textContent = 'copied ' + rows.length + ' row' + (rows.length === 1 ? '' : 's');
    } catch (e) {
      // Fallback: select a hidden textarea
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove();
      if (status) status.textContent = 'copied (fallback)';
    }
    setTimeout(() => { if (status) status.textContent = ''; }, 3000);
  });
})();
`;

function windowBar(origin: string, page: "popular" | "dashboard", active: Window, extraQs = ""): string {
  const base = page === "dashboard" ? "/admin/dashboard" : "/popular";
  const windows: Window[] = ["1h", "24h", "7d", "30d"];
  return `<div class="windowbar">` + windows.map(w => {
    const cls = w === active ? "on" : "";
    return `<a class="${cls}" href="${base}?window=${w}${extraQs}">${w}</a>`;
  }).join("") + `</div>`;
}

function repoWindowBar(slug: string, active: Window): string {
  const windows: Window[] = ["1h", "24h", "7d", "30d"];
  return `<div class="windowbar">` + windows.map(w => {
    const cls = w === active ? "on" : "";
    return `<a class="${cls}" href="/admin/repo/${esc(slug)}?window=${w}">${w}</a>`;
  }).join("") + `</div>`;
}

function renderPopular(origin: string, window: Window, repos: Awaited<ReturnType<typeof fetchTopRepos>>): string {
  // Belt-and-suspenders: even if AE has stale rows from an earlier parsing
  // bug, never render anything that doesn't look like a plausible GitHub
  // owner/repo (alphanumerics, dots, dashes, underscores).
  const slugOk = /^[\w.-]+$/;
  repos = repos.filter(r => slugOk.test(r.owner) && slugOk.test(r.repo));
  const rows = repos.map(r => {
    const slug = `${r.owner}/${r.repo}`;
    return `<div class="repo">
      <div class="name"><a href="/${esc(slug)}/tree">${esc(slug)}</a>
        &nbsp;<span class="muted">· <a href="https://github.com/${esc(slug)}">github</a></span></div>
      <div class="count">${fmtNum(r.requests)}</div>
      <div class="meta">p50 ${r.p50Ms}ms · p95 ${r.p95Ms}ms${r.errorRate > 0.01 ? ` · <span style="color:#c44">${(r.errorRate * 100).toFixed(1)}% err</span>` : ""}</div>
    </div>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Popular repos · gitvfs</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${BASE_CSS}</style>
</head><body>
<h1>Popular repos on gitvfs</h1>
<p class="lede">Most-requested public GitHub repositories served through this gitvfs instance. Counts are sampled estimates from Cloudflare Analytics Engine.</p>
${windowBar(origin, "popular", window)}
<div>${rows || `<p class="muted">No traffic in the last ${window}. Try a wider window: <a href="/popular?window=7d">7d</a> · <a href="/popular?window=30d">30d</a>.</p>`}</div>
<footer>
  <a href="/">gitvfs</a> · <a href="/llms.txt">/llms.txt</a> · <a href="/popular?window=${window}&format=json">json</a> · refreshes every 60s
</footer>
</body></html>`;
}

function renderDashboard(url: URL, b: Awaited<ReturnType<typeof fetchStatsBundle>>): string {
  const topReposRows = b.topRepos.map(r => {
    const slug = `${r.owner}/${r.repo}`;
    return `<div class="repo">
      <div class="name"><a href="/admin/repo/${esc(slug)}?window=${b.window}">${esc(slug)}</a>
        &nbsp;<span class="muted">· <a href="/${esc(slug)}/tree">browse</a> · <a href="https://github.com/${esc(slug)}">github</a></span></div>
      <div class="count">${fmtNum(r.requests)}</div>
      <div class="meta">p50 ${r.p50Ms}ms · p95 ${r.p95Ms}ms${r.errorRate > 0.01 ? ` · <span style="color:#c44">${(r.errorRate * 100).toFixed(1)}% err</span>` : ""}</div>
    </div>`;
  }).join("\n");
  const actionRows = b.byAction.map(a =>
    `<tr><td><code>${esc(a.action)}</code></td><td class="r">${fmtNum(a.requests)}</td><td class="r">${a.p50Ms}ms</td><td class="r">${a.p95Ms}ms</td><td class="r">${a.p99Ms}ms</td></tr>`
  ).join("");
  const statusRows = b.byStatus.map(s => {
    const color = s.status.startsWith("5") ? "color:#c44" : s.status.startsWith("4") ? "color:#c80" : "";
    return `<tr><td><code style="${color}">${esc(s.status)}</code></td><td class="r">${fmtNum(s.requests)}</td></tr>`;
  }).join("");
  const tsPoints = b.timeSeries.map(p => ({
    label: new Date(p.hour).toISOString().slice(11, 16),
    value: p.requests,
  }));
  const ingestRows = b.ingestFailures.map(f =>
    `<tr><td><a href="/admin/repo/${esc(f.owner)}/${esc(f.repo)}?window=${b.window}">${esc(f.owner)}/${esc(f.repo)}</a></td><td><code style="color:#c44">${esc(f.reason)}</code></td><td class="r">${fmtNum(f.count)}</td></tr>`
  ).join("");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>gitvfs · dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${BASE_CSS}</style>
</head><body>
<h1>gitvfs · dashboard</h1>
<p class="lede">Aggregated traffic for the last ${b.window}. Cached for 60s. Generated ${esc(b.generatedAt)}.</p>
${windowBar(url.origin, "dashboard", b.window, "")}

<div class="cards">
  <div class="card"><div class="label">Requests</div><div class="value">${fmtNum(b.totalRequests)}</div></div>
  <div class="card"><div class="label">Error rate</div><div class="value" style="${b.errorRate > 0.05 ? 'color:#c44' : ''}">${(b.errorRate * 100).toFixed(2)}%</div></div>
  <div class="card"><div class="label">Cache hit rate</div><div class="value">${(b.cacheHitRate * 100).toFixed(1)}%</div></div>
  <div class="card"><div class="label">Unique repos</div><div class="value">${fmtNum(b.uniqueRepos)}</div></div>
  <div class="card"><div class="label">p50 / p95 / p99</div><div class="value" style="font-size:18px">${b.p50Ms} / ${b.p95Ms} / ${b.p99Ms}<span style="font-size:12px;color:#888">ms</span></div></div>
</div>

<h2>Requests over time</h2>
${svgBarChart(tsPoints, { height: 140, valueLabel: (v) => fmtNum(v) })}

<h2>Top repos</h2>
<div>${topReposRows || '<p class="muted">No repo traffic yet.</p>'}</div>

<h2>By action</h2>
<table class="kv">
  <tr><td class="muted">action</td><td class="muted r">requests</td><td class="muted r">p50</td><td class="muted r">p95</td><td class="muted r">p99</td></tr>
  ${actionRows}
</table>

<h2>By status</h2>
<table class="kv">
  <tr><td class="muted">status</td><td class="muted r">requests</td></tr>
  ${statusRows}
</table>

<h2>Top errors (4xx / 5xx)</h2>
<table class="kv">
  <tr><td class="muted">status</td><td class="muted">action</td><td class="muted">repo</td><td class="muted r">requests</td><td class="muted r">p95</td></tr>
  ${b.topErrors.length === 0
    ? `<tr><td class="muted" colspan="5">no errors in this window — nice.</td></tr>`
    : b.topErrors.map(e => {
        const color = e.status.startsWith("5") ? "color:#c44" : "color:#c80";
        const repoCell = (e.owner && e.owner !== "-" && e.owner !== "")
          ? `<a href="/admin/repo/${esc(e.owner)}/${esc(e.repo)}?window=${b.window}">${esc(e.owner)}/${esc(e.repo)}</a>`
          : `<span class="muted">(non-repo)</span>`;
        return `<tr><td><code style="${color}">${esc(e.status)}</code></td><td><code>${esc(e.action)}</code></td><td>${repoCell}</td><td class="r">${fmtNum(e.requests)}</td><td class="r">${e.p95Ms}ms</td></tr>`;
      }).join("")}
</table>

<h2>Ingest failures</h2>
<p class="muted">Repos whose tarball couldn't be ingested — too large, GitHub rate-limited, or other. These are NOT counted in the request error rate above; they're emitted as a separate AE event.</p>
<table class="kv">
  <tr><td class="muted">repo</td><td class="muted">reason</td><td class="muted r">events</td></tr>
  ${ingestRows || `<tr><td class="muted" colspan="3">no ingest failures — nice.</td></tr>`}
</table>

<h2>What are agents doing? (by client)</h2>
<p class="muted">Inferred from <code>User-Agent</code> headers. Patterns from <a href="https://github.com/ai-robots-txt/ai.robots.txt">ai-robots-txt</a> (141 known AI/LLM bots) plus library/curl/browser detection.</p>
<table class="kv">
  <tr><td class="muted">client</td><td class="muted r">requests</td><td class="muted r">%</td><td class="muted r">unique repos</td><td class="muted r">p50</td><td class="muted r">p95</td><td class="muted r">err</td></tr>
  ${b.byClient.length === 0
    ? `<tr><td class="muted" colspan="7">no traffic yet.</td></tr>`
    : b.byClient.map(c => {
        const pct = b.totalRequests > 0 ? ((c.requests / b.totalRequests) * 100).toFixed(1) : "0";
        const errColor = c.errorRate > 0.05 ? "color:#c44" : "";
        return `<tr><td><code>${esc(c.client)}</code></td><td class="r">${fmtNum(c.requests)}</td><td class="r">${pct}%</td><td class="r">${fmtNum(c.uniqueRepos)}</td><td class="r">${c.p50Ms}ms</td><td class="r">${c.p95Ms}ms</td><td class="r" style="${errColor}">${(c.errorRate * 100).toFixed(1)}%</td></tr>`;
      }).join("")}
</table>

<h2>Slow requests (>5s)</h2>
<p class="muted">Long-tail latency grouped by (action, repo, client). Mostly first-time tarball ingest; recurring entries are worth investigating.</p>
<table class="kv">
  <tr><td class="muted">action</td><td class="muted">repo</td><td class="muted">client</td><td class="muted r">slow</td><td class="muted r">total</td><td class="muted r">p95</td><td class="muted r">p99</td></tr>
  ${b.slowRequests.length === 0
    ? `<tr><td class="muted" colspan="7">no slow requests — nice.</td></tr>`
    : b.slowRequests.map(s => {
        const slug = `${s.owner}/${s.repo}`;
        return `<tr><td><code>${esc(s.action)}</code></td><td><a href="/admin/repo/${esc(slug)}?window=${b.window}">${esc(slug)}</a></td><td><code>${esc(s.client)}</code></td><td class="r">${fmtNum(s.slowCount)}</td><td class="r">${fmtNum(s.total)}</td><td class="r">${s.p95Ms}ms</td><td class="r">${s.p99Ms}ms</td></tr>`;
      }).join("")}
</table>

<h2>Recent failures</h2>
<p class="muted">Most recent 4xx/5xx grouped by minute. Tick the rows you want to triage, then <button class="btn" id="copy-failures">copy as markdown</button> and paste into your agent of choice.</p>
<div class="failureslist">
  ${b.recentFailures.length === 0
    ? `<p class="muted">no failures in this window — nice.</p>`
    : `
      <div class="failures-toolbar">
        <label><input type="checkbox" id="select-all-failures"> select all</label>
        <span id="copy-status" class="muted"></span>
      </div>
      <table class="kv failures">
        <tr><td></td><td class="muted">time</td><td class="muted">status</td><td class="muted">action</td><td class="muted">path</td><td class="muted">client</td><td class="muted r">×</td></tr>
        ${b.recentFailures.map((f, i) => {
          const statusColor = f.status.startsWith("5") ? "color:#c44" : "color:#c80";
          const t = f.minute.slice(11, 16);          // HH:MM
          const date = f.minute.slice(0, 10);         // YYYY-MM-DD
          // Pack everything needed for the copy into data-* attrs so the
          // client-side JS doesn't have to re-derive anything.
          return `<tr>
            <td><input type="checkbox" class="fcheck" data-i="${i}"
              data-status="${esc(f.status)}" data-action="${esc(f.action)}"
              data-path="${esc(f.path)}" data-client="${esc(f.client)}"
              data-when="${esc(date)} ${esc(t)}" data-count="${f.count}"></td>
            <td class="muted">${esc(t)}</td>
            <td><code style="${statusColor}">${esc(f.status)}</code></td>
            <td><code>${esc(f.action)}</code></td>
            <td><a href="${esc(f.path)}"><code>${esc(f.path)}</code></a></td>
            <td><code>${esc(f.client)}</code></td>
            <td class="r">${fmtNum(f.count)}</td>
          </tr>`;
        }).join("")}
      </table>
    `}
</div>

<footer>
  <a href="/admin/stats?window=${b.window}">stats json</a> ·
  <a href="/popular?window=${b.window}">public popular</a> ·
  <a href="/">gitvfs</a>
</footer>
<script>${FAILURES_JS}</script>
</body></html>`;
}

// --- per-repo detail page -------------------------------------------------

function svgBarChart(rows: { label: string; value: number }[], opts: { width?: number; height?: number; valueLabel?: (v: number) => string } = {}): string {
  const w = opts.width ?? 720;
  const h = opts.height ?? 160;
  const pad = { l: 8, r: 8, t: 8, b: 28 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  if (!rows.length) return `<div class="muted">no data</div>`;
  const max = Math.max(1, ...rows.map(r => r.value));
  const bw = innerW / rows.length;
  const bars = rows.map((r, i) => {
    const x = pad.l + i * bw + 2;
    const bh = (r.value / max) * innerH;
    const y = pad.t + (innerH - bh);
    const label = (opts.valueLabel ?? ((v: number) => String(v)))(r.value);
    return `<g>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${bh.toFixed(1)}" fill="currentColor" opacity="0.85"/>
      <title>${esc(r.label)}: ${esc(label)}</title>
      <text x="${(x + (bw - 4) / 2).toFixed(1)}" y="${(h - 14).toFixed(1)}" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">${esc(r.label)}</text>
      <text x="${(x + (bw - 4) / 2).toFixed(1)}" y="${(h - 2).toFixed(1)}" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.5">${esc(label)}</text>
    </g>`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" style="color:#0a6cf1">${bars}</svg>`;
}

function renderRepoDetail(url: URL, owner: string, repo: string, d: RepoDetail): string {
  const slug = `${owner}/${repo}`;
  const hist = d.latencyHistogram
    .sort((a, b) => a.bucketOrder - b.bucketOrder)
    .map(r => ({ label: r.bucket, value: r.requests }));
  const ts = d.timeSeries.map(p => ({
    label: new Date(p.hour).toISOString().slice(11, 16),
    value: p.requests,
  }));
  const actionRows = d.byAction.map(a =>
    `<tr><td><code>${esc(a.action)}</code></td><td class="r">${fmtNum(a.requests)}</td><td class="r">${a.p50Ms}ms</td><td class="r">${a.p95Ms}ms</td></tr>`,
  ).join("");
  const statusRows = d.byStatus.map(s => {
    const color = s.status.startsWith("5") ? "color:#c44" : s.status.startsWith("4") ? "color:#c80" : "";
    return `<tr><td><code style="${color}">${esc(s.status)}</code></td><td class="r">${fmtNum(s.requests)}</td></tr>`;
  }).join("");
  const sourceRows = d.bySource.map(s => {
    const hint = s.source === "edge" ? "(cache hit — fast)" : s.source === "do" ? "(DO — includes cold ingest)" : "";
    return `<tr><td><code>${esc(s.source)}</code> <span class="muted">${esc(hint)}</span></td><td class="r">${fmtNum(s.requests)}</td><td class="r">${s.p50Ms}ms</td><td class="r">${s.p95Ms}ms</td></tr>`;
  }).join("");
  const refRows = d.byRefKind.map(r =>
    `<tr><td><code>${esc(r.refKind)}</code></td><td class="r">${fmtNum(r.requests)}</td></tr>`,
  ).join("");
  const cacheHit = (() => {
    const total = d.bySource.reduce((a, r) => a + r.requests, 0);
    const edge = d.bySource.find(r => r.source === "edge")?.requests ?? 0;
    return total > 0 ? `${((edge / total) * 100).toFixed(1)}%` : "—";
  })();
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>${esc(slug)} · gitvfs admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${BASE_CSS}</style>
</head><body>
<p class="muted"><a href="/admin/dashboard">← dashboard</a></p>
<h1>${esc(slug)}</h1>
<p class="lede">
  Per-repo detail · <a href="/${esc(slug)}/tree">browse on gitvfs</a> ·
  <a href="https://github.com/${esc(slug)}">github</a> ·
  generated ${esc(d.generatedAt)}.
</p>
${repoWindowBar(slug, d.window)}

<div class="cards">
  <div class="card"><div class="label">Requests</div><div class="value">${fmtNum(d.totals.requests)}</div></div>
  <div class="card"><div class="label">Error rate</div><div class="value">${d.totals.requests > 0 ? ((d.totals.errors / d.totals.requests) * 100).toFixed(2) : "0.00"}%</div></div>
  <div class="card"><div class="label">p50 / p95 / p99</div><div class="value" style="font-size:18px">${d.totals.p50Ms} / ${d.totals.p95Ms} / ${d.totals.p99Ms}<span style="font-size:12px;color:#888">ms</span></div></div>
  <div class="card"><div class="label">Cache hit rate</div><div class="value">${cacheHit}</div></div>
</div>

<h2>Requests over time (hourly)</h2>
${svgBarChart(ts, { height: 140, valueLabel: (v) => fmtNum(v) })}

<h2>Latency distribution</h2>
${svgBarChart(hist, { height: 160, valueLabel: (v) => fmtNum(v) })}
<p class="muted">Bars sized by request count in each latency bucket. Long-tail buckets (1s+) are usually cold tarball ingest.</p>

<h2>By source</h2>
<table class="kv">
  <tr><td class="muted">source</td><td class="muted r">requests</td><td class="muted r">p50</td><td class="muted r">p95</td></tr>
  ${sourceRows || `<tr><td class="muted" colspan="4">no data</td></tr>`}
</table>

<h2>By action</h2>
<table class="kv">
  <tr><td class="muted">action</td><td class="muted r">requests</td><td class="muted r">p50</td><td class="muted r">p95</td></tr>
  ${actionRows || `<tr><td class="muted" colspan="4">no data</td></tr>`}
</table>

<h2>By status</h2>
<table class="kv">
  <tr><td class="muted">status</td><td class="muted r">requests</td></tr>
  ${statusRows || `<tr><td class="muted" colspan="2">no data</td></tr>`}
</table>

<h2>By ref kind</h2>
<table class="kv">
  <tr><td class="muted">ref kind</td><td class="muted r">requests</td></tr>
  ${refRows || `<tr><td class="muted" colspan="2">no data</td></tr>`}
</table>

<h2>Errors</h2>
<table class="kv">
  <tr><td class="muted">status</td><td class="muted">action</td><td class="muted r">requests</td><td class="muted r">p95</td></tr>
  ${d.errorGroups.length === 0
    ? `<tr><td class="muted" colspan="4">no errors — nice.</td></tr>`
    : d.errorGroups.map(e => {
        const color = e.status.startsWith("5") ? "color:#c44" : "color:#c80";
        return `<tr><td><code style="${color}">${esc(e.status)}</code></td><td><code>${esc(e.action)}</code></td><td class="r">${fmtNum(e.requests)}</td><td class="r">${e.p95Ms}ms</td></tr>`;
      }).join("")}
</table>

<footer>
  <a href="/admin/repo/${esc(slug)}?window=${d.window}&format=json">json</a> ·
  <a href="/admin/dashboard">dashboard</a> ·
  <a href="/popular">popular</a>
</footer>
</body></html>`;
}

// Bucket the pathname into a low-cardinality action name for metrics.
// Avoids emitting one metric series per unique repo/path.
function endpointBucket(pathname: string): string {
  if (pathname === "/" || pathname === "") return "landing";
  if (pathname === "/llms.txt" || pathname === "/.well-known/llms.txt") return "llms";
  if (pathname === "/health") return "health";
  if (pathname === "/favicon.ico" || pathname === "/robots.txt") return "static";
  if (pathname === "/popular") return "popular";
  if (pathname.startsWith("/admin/")) return "admin";
  const segs = pathname.split("/").filter(Boolean);
  // Expect at least /owner/repo/<action>. Fallback to "other" on noise.
  if (segs.length < 3) return "other";
  const action = segs[2].split("?")[0];
  if (ACTIONS.has(action)) return action;
  return "other";
}

// Bucket the User-Agent into a low-cardinality "client" label so the
// dashboard can answer "what are agents actually doing?". Patterns derived
// from ai-robots-txt/ai.robots.txt (141 known AI/LLM crawler & agent UAs).
// Order matters — most specific first. Lowercased input.
//
// Buckets are coarse on purpose: ~15 stable categories instead of 141
// version-tagged strings, so the dashboard breakdown stays useful month
// over month rather than fragmenting on every minor release bump.
function classifyClient(ua: string | null): string {
  if (!ua) return "unknown";
  const u = ua.toLowerCase();
  // Anthropic's CLI is the agent identity we care about most — split it out
  // from "claude" so we can see Claude Code adoption specifically.
  if (/claude-code|anthropic-claude-code/.test(u)) return "claude-code";
  if (/claudebot|claude-user|claude-web|claude-searchbot|anthropic-ai/.test(u)) return "claude";
  if (/gptbot|chatgpt-user|chatgpt agent|oai-searchbot|\boperator\b|openai/.test(u)) return "chatgpt";
  if (/cursor/.test(u)) return "cursor";
  if (/copilot|github-copilot/.test(u)) return "copilot";
  if (/devin/.test(u)) return "devin";
  if (/perplexity/.test(u)) return "perplexity";
  if (/google-extended|googleother|notebooklm|googleagent|gemini|google-agent|google-firebase|cloudvertexbot|bedrockbot/.test(u)) return "gemini";
  if (/mistralai-user/.test(u)) return "mistral";
  if (/deepseekbot/.test(u)) return "deepseek";
  if (/cohere-ai|cohere-training/.test(u)) return "cohere";
  if (/meta-externalagent|meta-externalfetcher|facebookbot|facebookexternalhit/.test(u)) return "meta-ai";
  if (/firecrawl|tavilybot|exabot|linkupbot|kagi-fetcher|youbot|phindbot/.test(u)) return "ai-search";
  if (/posthog/.test(u)) return "posthog";
  if (/ccbot|diffbot|apifybot|bytespider|panscient|amazonbot|applebot|crawl4ai|webzio-extended|img2dataset|laion/.test(u)) return "crawler";
  if (/^curl\/|\(curl\/|libcurl/.test(u)) return "curl";
  if (/wget|libwww/.test(u)) return "curl";
  if (/python-requests|python-urllib|httpx|aiohttp|node-fetch|axios|got\/|\bky\/|okhttp|reqwest|undici/.test(u)) return "library";
  if (/^mozilla\/5/.test(u) && !/bot|crawler|spider/.test(u)) return "browser";
  if (/bot|crawler|spider|scraper/.test(u)) return "other-bot";
  return "other";
}

// Truncated path+query bucket for the failures list. Strips any obvious
// secrets (we don't currently accept any, but defensive). 120 chars is
// long enough to identify the request, short enough to keep AE blob
// storage in check.
function pathBucket(pathname: string, search: string): string {
  // Strip query value of any param literally named "key" or "token".
  let s = search;
  if (s) {
    s = s.replace(/([?&])(key|token|secret)=[^&]*/gi, "$1$2=REDACTED");
  }
  const combined = pathname + s;
  return combined.length > 120 ? combined.slice(0, 117) + "..." : combined;
}

// Extract (owner, repo, refKind) from a request path so we can group AE
// metrics by repo. Returns "-" for non-repo paths so blob columns stay
// non-null (AE rejects undefined blobs, but accepts empty strings).
function repoFromPath(pathname: string): { owner: string; repo: string; refKind: string } {
  // Reserved top-level paths that look like /owner/repo but aren't.
  // Without this, /admin/stats parses as owner=admin, repo=stats and
  // pollutes the popular list.
  if (pathname.startsWith("/admin/") || pathname === "/popular"
      || pathname === "/llms.txt" || pathname === "/.well-known/llms.txt"
      || pathname === "/health" || pathname === "/favicon.ico" || pathname === "/robots.txt"
      || pathname === "/" || pathname === "") {
    return { owner: "-", repo: "-", refKind: "-" };
  }
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length < 2) return { owner: "-", repo: "-", refKind: "-" };
  const owner = segs[0];
  let repoAndRef = segs[1];
  if (repoAndRef.endsWith(".git")) repoAndRef = repoAndRef.slice(0, -4);
  const at = repoAndRef.indexOf("@");
  let repo = repoAndRef;
  let refKind = "default";
  if (at >= 0) {
    repo = repoAndRef.slice(0, at);
    const ref = repoAndRef.slice(at + 1);
    if (/^[0-9a-f]{40}$/i.test(ref)) refKind = "sha";
    else if (/^v?\d+\.\d+/.test(ref)) refKind = "tag";
    else refKind = "branch";
  }
  // Validate — anything weird means this isn't really a repo route.
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
    return { owner: "-", repo: "-", refKind: "-" };
  }
  return { owner, repo, refKind };
}

async function handle(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  pathname: string,
  internalBypass: boolean,
): Promise<Response> {
    if (pathname === "/" || pathname === "") {
      const body = landing(url.origin);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
      const sha = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
      return text(body, 200, { "x-gitvfs-doc-sha": sha });
    }
    if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (pathname === "/robots.txt") return text("User-agent: *\nDisallow:\n");
    if (pathname === "/health") return json({ ok: true });
    if (pathname === "/llms.txt" || pathname === "/.well-known/llms.txt") {
      return text(llmsTxt(url.origin));
    }
    if (pathname === "/popular") return handlePopular(env, url);
    if (pathname === "/admin" || pathname === "/admin/") {
      return new Response(null, { status: 302, headers: { location: "/admin/dashboard" } });
    }
    if (pathname === "/admin/stats") return handleAdminStats(env, url);
    if (pathname === "/admin/dashboard") return handleAdminDashboard(env, url);
    if (pathname.startsWith("/admin/repo/")) {
      const parts = pathname.slice("/admin/repo/".length).split("/").filter(Boolean);
      if (parts.length >= 2) return handleAdminRepo(env, url, parts[0], parts[1]);
      return err("bad_repo_path", "Expected /admin/repo/<owner>/<repo>.", 400);
    }

    const cache = (caches as unknown as { default: Cache }).default;
    // Bypass edge cache for endpoints that must always reflect current state:
    //   /head  — freshness probe, always recomputed (cheap)
    //   ?refresh=1 — caller explicitly wants fresh
    const bypassCache =
      url.searchParams.get("refresh") === "1" ||
      pathname.endsWith("/head") ||
      pathname.includes("/status");
    if (request.method === "GET" && !bypassCache) {
      const cached = await cache.match(request);
      if (cached) {
        // Re-stamp with edge source so agents/auditors can tell this was served
        // from CF colo cache (we did not hit the DO or GitHub).
        const stamped = new Response(cached.body, cached);
        stamped.headers.set("x-gitvfs-source", "edge");
        return stamped;
      }
    }

    const parsed = parsePath(pathname);
    if (!parsed) return badPath(pathname + (url.search || ""));
    const { owner, repo, ref, rest } = parsed;

    // AS-009: a `$` in a ref is never a valid git ref — it's almost always a
    // bash variable that didn't get substituted before the URL left the shell
    // (e.g. `curl ".../repo@$PI/..."` pasted into a tool where `PI` isn't set).
    // GitHub returns 422 on the lookup, which we'd otherwise surface as a
    // generic 404 `ref_not_found` — useless to anyone debugging.
    if (ref && /\$/.test(ref)) {
      return err(
        "unexpanded_shell_variable",
        `Ref '${ref}' contains '$', which git refs never do — looks like an unexpanded shell variable.`,
        400,
        {
          ref,
          hint: `Use the literal SHA (e.g. @<40-char-sha>), omit @<ref> entirely to use HEAD, or set the variable before substitution (e.g. \`SHA=abc123 curl "${pathname.replace(ref, "$SHA")}"\`).`,
        },
      );
    }

    const forceRefresh = url.searchParams.get("refresh") === "1";

    // Resolve ref → SHA. Only a full 40-char SHA is trusted as-is.
    // Short SHAs look like a SHA but MUST be resolved (or we'd cache the wrong commit).
    let sha: string;
    let resolvedAt: string | null = null;
    let ageSeconds: number | null = null;
    let fromCache = false;
    const refIsFullSha = !!ref && isFullSha(ref);
    const refIsTagLike = !!ref && !refIsFullSha && looksLikeTag(ref);
    const refIsMutable = !refIsFullSha; // tags/branches/default can all move in principle

    try {
      if (refIsFullSha) {
        sha = ref!;
      } else {
        const resolved = await resolveRefCached(
          ctx, owner, repo, ref ?? "HEAD", env.GITHUB_TOKEN,
          { forceRefresh },
        );
        sha = resolved.sha;
        resolvedAt = resolved.resolvedAt;
        ageSeconds = resolved.ageSeconds;
        fromCache = resolved.fromCache;
      }
    } catch (e: any) {
      const msg = e?.message ?? "";
      const status = /\b404\b/.test(msg) ? 404 : /\b422\b/.test(msg) ? 404 : 502;
      return err(
        "ref_not_found",
        `Could not resolve ${owner}/${repo}@${ref ?? "HEAD"}: ${msg}`,
        status,
      );
    }

    const action = rest[0] ?? "";

    // /head — cheap freshness probe. Returns the resolved SHA + timestamp only,
    // no DO ingest, no tree listing. Exactly what an agent uses to answer
    // "has this branch moved since I last looked?"
    if (action === "head") {
      // Source: "github" if we just hit GitHub, "ref-cache" if the ref cache
      // answered, "direct" for SHA-pinned URLs (no resolution needed).
      const source = refIsFullSha ? "direct" : fromCache ? "ref-cache" : "github";
      return json({
        owner,
        repo,
        ref: ref ?? "HEAD",
        sha,
        pinned: refIsFullSha,
        resolvedAt,
        ageSeconds,
        fromCache,
      }, 200, {
        "cache-control": "no-store",
        "x-gitvfs-source": source,
      });
    }

    const id = env.REPO.idFromName(`${owner}/${repo}@${sha}`);
    const stub = env.REPO.get(id);

    if (action === "status") {
      const s = await stub.status();
      return json({ owner, repo, sha, ref: ref ?? null, resolvedAt, ageSeconds, ...s });
    }

    // Kick off (or wait for) ingest. This can fail on very large repos (Worker CPU cap).
    let status;
    try {
      status = await stub.ensureIngested(owner, repo, sha);
    } catch (e: any) {
      // Worker CPU or subrequest cap hit mid-ingest. Partial rows stay put
      // (we removed the DELETE-on-retry destructive path), so a retry often
      // progresses further than the first attempt.
      //
      // Elevated-severity log so it shows up in log-based alerts (any log
      // with level=warn on this code is actionable — either the repo is
      // too big for the CPU budget or GitHub is throttling).
      console.log(JSON.stringify({
        t: new Date().toISOString(),
        level: "warn",
        event: "ingest_too_large",
        owner, repo, sha,
        error: e?.message ?? String(e),
      }));
      if (env.METRICS) {
        try {
          env.METRICS.writeDataPoint({
            blobs: ["ingest_failure", `${owner}/${repo}`, "ingest_too_large"],
            doubles: [1],
            indexes: ["ingest_too_large"],
          });
        } catch {}
      }
      return err(
        "ingest_too_large",
        `Ingest of ${owner}/${repo}@${sha.slice(0, 7)} exceeded per-request limits. Retry — partial state was preserved and progress accumulates.`,
        503,
        { sha, owner, repo },
        { "retry-after": "5" },
      );
    }
    if (status.state === "error") {
      // Classified upstream errors from the DO get mapped to appropriate HTTP
      // codes. Critically: a failed tarball fetch is NOT a 404 — that would
      // blur the distinction between "this commit doesn't exist" and "this
      // file doesn't exist inside the commit". We return 502 so agents can
      // tell the failure happened upstream (F2/F3 fix).
      const msg = status.error ?? "unknown ingest error";
      if (msg.startsWith("tarball_not_found")) {
        return err("ingest_failed", msg, 502, { sha }, { "retry-after": "5" });
      }
      if (msg.startsWith("tarball_rate_limited")) {
        return throttled("github_rate_limited", msg, 30, { sha });
      }
      if (msg.startsWith("tarball_forbidden")) return err("forbidden", msg, 403, { sha });
      if (msg.startsWith("tarball_upstream_unavailable")) {
        return err("upstream_unavailable", msg, 503, { sha }, { "retry-after": "5" });
      }
      return err("ingest_failed", msg, 502, { sha });
    }
    if (status.state === "ingesting") {
      // A prior invocation started ingest but didn't finish (e.g. hit the
      // Worker CPU cap). Surface this distinctly so agents don't interpret
      // partial results as "no matches" or "file not found".
      return err(
        "not_ready",
        "Ingest is in progress for this commit — retry in a few seconds.",
        202,
        { sha, owner, repo, state: "ingesting", startedAt: status.startedAt },
        { "retry-after": "3" },
      );
    }
    if (status.state !== "ready") {
      // "not_ingested" here means ensureIngested returned without kicking an
      // ingest, which should not happen via this path — defensive.
      return err(
        "not_ready",
        `Repo is not ready (state: ${status.state}).`,
        503,
        { sha, owner, repo, state: status.state },
        { "retry-after": "3" },
      );
    }

    const cacheControl = cacheControlFor(refIsFullSha, refIsTagLike);
    // All payloads past this point came from the DO (maybe after a GitHub
    // tarball fetch to populate it). If the edge cache had hit, we would have
    // returned up in the bypass block above.
    const source = "do";
    const metaHeaders: Record<string, string> = {
      "x-gitvfs-sha": sha,
      "x-gitvfs-owner": owner,
      "x-gitvfs-repo": repo,
      "x-gitvfs-files": String(status.filesStored ?? 0),
      "x-gitvfs-ref-resolved": refIsFullSha ? "direct" : "github",
      "x-gitvfs-pinned": String(refIsFullSha),
      "x-gitvfs-mutable": String(refIsMutable),
      "x-gitvfs-source": source,
      "cache-control": cacheControl,
    };
    if (ref) metaHeaders["x-gitvfs-ref"] = ref;
    if (resolvedAt) metaHeaders["x-gitvfs-resolved-at"] = resolvedAt;
    if (ageSeconds !== null) metaHeaders["x-gitvfs-age-seconds"] = String(ageSeconds);
    if (!refIsFullSha) {
      // Hint to clients: we resolved it; use the SHA URL for long cache.
      metaHeaders["x-gitvfs-pin-hint"] =
        `/${owner}/${repo}@${sha}${rest.length ? "/" + rest.join("/") : ""}`;
    }

    const finalize = (resp: Response): Response => {
      if (resp.ok && request.method === "GET") {
        ctx.waitUntil(cache.put(request, resp.clone()));
      }
      return resp;
    };

    if (action === "" || action === undefined) {
      return Response.redirect(
        new URL(`/${owner}/${repo}${ref ? "@" + ref : ""}/tree`, url).toString(),
        302,
      );
    }

    // -----------------------------------------------------------------
    // tree / tree.json
    // -----------------------------------------------------------------
    if (action === "tree" || action === "tree.json") {
      // AS-001: reject unknown query params instead of silently ignoring them.
      // Underscore-prefixed params are reserved for client-side cache-busting
      // (see test/common.ts `_cb=`).
      const TREE_PARAMS = new Set([
        "glob", "path", "sizes", "outlines", "count", "depth", "refresh",
      ]);
      for (const key of url.searchParams.keys()) {
        if (key.startsWith("_")) continue;
        if (!TREE_PARAMS.has(key)) {
          return err(
            "unknown_query_param",
            `Unknown query param '${key}' on /${action}. Known: ${[...TREE_PARAMS].sort().join(", ")}.`,
            400,
            { param: key, hint: "Did you mean /tree/<subpath> or ?path=<subpath>?" },
          );
        }
      }
      const rawGlob = url.searchParams.get("glob");
      if (rawGlob === "") return err("bad_glob", "Empty glob.", 400);
      const glob = rawGlob ? normalizeGlob(rawGlob) : undefined;
      // `prefix` may come from the URL segment (`/tree/src`) OR from the
      // query param (`?path=src`). They are mutually exclusive; ?path= is
      // accepted because agents reach for it by analogy with bash tree/ls/find.
      let prefix = rest.slice(1).join("/") || undefined;
      const pathParam = readPathParam(url);
      if (pathParam instanceof Response) return pathParam;
      if (pathParam) {
        if (prefix) {
          return err(
            "conflicting_path",
            "Use /tree/<subpath> OR ?path=<subpath>, not both.",
            400,
            { urlPath: prefix, queryPath: pathParam.path },
          );
        }
        prefix = pathParam.path;
      }
      const withSizes = url.searchParams.get("sizes") === "1";
      const withOutlines = url.searchParams.get("outlines") === "1";
      const countOnly = url.searchParams.get("count") === "1";
      const depthParam = url.searchParams.get("depth");

      // AS-002: helper for per-response entry-count header on /tree responses.
      const withCountHeader = (n: number): Record<string, string> => ({
        ...metaHeaders,
        "x-gitvfs-entries": String(n),
      });

      if (countOnly) {
        const n = await stub.treeCount({ glob, prefix });
        const h = withCountHeader(n);
        if (action === "tree.json") return finalize(json({ sha, count: n }, 200, h));
        return finalize(text(String(n) + "\n", 200, h));
      }

      // One-level listing — the `ls` analogue. Synthesizes directory entries
      // so an agent asking "what's in this folder?" doesn't get a flat
      // recursive dump. Mutually exclusive with glob / outlines.
      if (depthParam === "1") {
        if (glob) return err("bad_params", "?depth=1 cannot combine with ?glob (it is already scoped).", 400);
        if (withOutlines) return err("bad_params", "?depth=1 cannot combine with ?outlines.", 400);
        const entries = await stub.treeLevel(prefix !== undefined ? { prefix } : {});
        const h = withCountHeader(entries.length);
        if (action === "tree.json") {
          return finalize(json({ sha, count: entries.length, entries }, 200, h));
        }
        const body = entries.map((e) => {
          const name = e.path.split("/").pop() ?? e.path;
          if (e.kind === "dir") return `${name}/`;
          if (!withSizes) return name;
          const lines = e.lines !== undefined ? String(e.lines) : "-";
          return `${name}\t${e.size ?? 0}\t${lines}`;
        }).join("\n");
        return finalize(text(body + (entries.length ? "\n" : ""), 200, h));
      }

      // Tree with per-file outlines: planning view in one request.
      // Decodes content per entry, so capped and JSON-only.
      if (withOutlines) {
        if (action === "tree") {
          return err(
            "needs_json",
            "?outlines=1 only applies to /tree.json (structured data). Use tree.json.",
            400,
          );
        }
        const { entries, truncated } = await stub.treeWithOutlines({ glob, prefix });
        const outlineHeaders: Record<string, string> = withCountHeader(entries.length);
        if (truncated) outlineHeaders["x-gitvfs-truncated"] = "true";
        return finalize(json(
          { sha, count: entries.length, truncated, entries },
          200,
          outlineHeaders,
        ));
      }

      const entries = await stub.tree({ glob, prefix, withSizes });
      const h = withCountHeader(entries.length);
      if (action === "tree.json") {
        // Always attach language (free from path), include size/lines when sizes=1.
        const enriched = entries.map((e) => {
          const out: {
            path: string; size?: number; lines?: number; language: string;
          } = { path: e.path, language: detectLanguage(e.path) };
          if (e.size !== undefined) out.size = e.size;
          if ((e as any).lines !== undefined) out.lines = (e as any).lines;
          return out;
        });
        return finalize(json({ sha, count: enriched.length, entries: enriched }, 200, h));
      }
      const body = withSizes
        ? entries.map((e) => {
            const lines = (e as any).lines;
            return typeof lines === "number"
              ? `${e.path}\t${e.size ?? 0}\t${lines}`
              : `${e.path}\t${e.size ?? 0}`;
          }).join("\n")
        : entries.map((e) => e.path).join("\n");
      return finalize(text(body + (entries.length ? "\n" : ""), 200, h));
    }

    // -----------------------------------------------------------------
    // file
    // -----------------------------------------------------------------
    if (action === "file") {
      const path = rest.slice(1).join("/");
      if (!path) return err("missing_path", "Missing file path.", 400);

      // Fast HEAD: don't load the BLOB, just existence + metadata.
      if (request.method === "HEAD") {
        const s = await stub.stat(path);
        if (!s) return new Response(null, { status: 404, headers: { ...CORS_HEADERS, ...metaHeaders } });
        const headHeaders: Record<string, string> = {
          "content-type": s.mime + "; charset=utf-8",
          "content-length": String(s.size),
          ...CORS_HEADERS,
          "x-gitvfs-language": s.language,
          ...metaHeaders,
        };
        if (typeof s.lines === "number") headHeaders["x-gitvfs-lines"] = String(s.lines);
        return new Response(null, { status: 200, headers: headHeaders });
      }

      const file = await stub.read(path);
      if (!file) {
        const suggestions = await stub.suggestPaths(path);
        return json(
          { error: "not_found", path, suggestions, docs: DOCS_URL, llms_txt: LLMS_TXT_URL },
          404,
          metaHeaders,
        );
      }

      const language = detectLanguage(path);
      // Prefer the precomputed line count; fall back to counting bytes for older DO schemas.
      const totalLines = file.lines ?? countLines(file.content);
      const numbered = url.searchParams.get("numbered") === "1";

      // AS-004: prefix each line with ` N | ` when ?numbered=1. The pad width
      // is the width of the largest line number in the rendered range, so the
      // pipes align and the agent can read line numbers at a glance.
      const withLineNumbers = (lines: string[], startLine: number): string => {
        const lastLine = startLine + lines.length - 1;
        const pad = String(lastLine).length;
        return lines
          .map((L, i) => `${String(startLine + i).padStart(pad)} | ${L}`)
          .join("\n");
      };

      const linesParam = url.searchParams.get("lines");
      if (linesParam) {
        const m = linesParam.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) {
          return err(
            "bad_lines",
            `Invalid lines parameter: ${linesParam}. Expected e.g. "10-50" or "42".`,
            400,
          );
        }
        const decoder = new TextDecoder("utf-8", { fatal: false });
        const text_ = decoder.decode(file.content);
        const allLines = splitLogicalLines(text_);
        const start = Math.max(1, parseInt(m[1], 10));
        const end = m[2] ? parseInt(m[2], 10) : start;
        if (end < start) {
          return err("bad_lines", `Range ${start}-${end} is empty (end < start).`, 400);
        }
        if (start > totalLines) {
          return err(
            "line_range_not_satisfiable",
            `Range ${start}-${end} starts after end of file (${totalLines} lines).`,
            416,
            { totalLines },
          );
        }
        const effEnd = Math.min(totalLines, end);
        const sliceLines = allLines.slice(start - 1, effEnd);
        const body = numbered
          ? withLineNumbers(sliceLines, start)
          : sliceLines.join("\n");
        return finalize(new Response(body, {
          status: 200,
          headers: {
            "content-type": file.mime + "; charset=utf-8",
            ...CORS_HEADERS,
            "x-gitvfs-line-range": `${start}-${effEnd}`,
            "x-gitvfs-total-lines": String(totalLines),
            "x-gitvfs-language": language,
            ...(numbered ? { "x-gitvfs-numbered": "1" } : {}),
            ...metaHeaders,
          },
        }));
      }

      // Whole-file path, optionally numbered.
      if (numbered) {
        const decoder = new TextDecoder("utf-8", { fatal: false });
        const allLines = splitLogicalLines(decoder.decode(file.content));
        const body = withLineNumbers(allLines, 1);
        return finalize(new Response(body, {
          status: 200,
          headers: {
            "content-type": file.mime + "; charset=utf-8",
            ...CORS_HEADERS,
            "x-gitvfs-lines": String(totalLines),
            "x-gitvfs-language": language,
            "x-gitvfs-numbered": "1",
            ...metaHeaders,
          },
        }));
      }

      return finalize(new Response(file.content as BodyInit, {
        status: 200,
        headers: {
          "content-type": file.mime + "; charset=utf-8",
          "content-length": String(file.size),
          ...CORS_HEADERS,
          "x-gitvfs-lines": String(totalLines),
          "x-gitvfs-language": language,
          ...metaHeaders,
        },
      }));
    }

    // -----------------------------------------------------------------
    // files — batched read
    //
    //   GET /:owner/:repo[@:ref]/files?paths=a&paths=b[&format=ndjson]
    //
    // Returns up to 50 files in one round trip. Missing paths are surfaced
    // as `{path, error: "not_found"}` entries rather than failing the whole
    // request. `?paths=a,b,c` (comma-separated) works too.
    // -----------------------------------------------------------------
    if (action === "files") {
      // Accept both repeated ?paths= and comma-separated values.
      const raw = url.searchParams.getAll("paths");
      if (raw.length === 0) {
        return err(
          "missing_paths",
          "Missing ?paths=<file>. Repeat or comma-separate for multiple.",
          400,
        );
      }
      const paths: string[] = [];
      for (const p of raw) {
        if (p.includes(",")) {
          for (const part of p.split(",")) {
            const t = part.trim();
            if (t) paths.push(t);
          }
        } else if (p) {
          paths.push(p);
        }
      }
      if (paths.length === 0) {
        return err("missing_paths", "No paths provided.", 400);
      }
      if (paths.length > 50) {
        return err("too_many_paths", `Max 50 paths per request; got ${paths.length}.`, 400);
      }
      for (const p of paths) {
        if (!isValidFilePath(p)) {
          return err("bad_path", `Invalid path in ?paths: ${JSON.stringify(p)}`, 400);
        }
      }

      const results = await stub.readMany(paths);
      const format = url.searchParams.get("format") ?? "json";
      if (format === "ndjson") {
        const body = results.map((r) => JSON.stringify(r)).join("\n") + (results.length ? "\n" : "");
        return finalize(new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            ...CORS_HEADERS,
            ...metaHeaders,
          },
        }));
      }
      return finalize(json({ sha, count: results.length, results }, 200, metaHeaders));
    }

    // -----------------------------------------------------------------
    // stat
    // -----------------------------------------------------------------
    if (action === "stat") {
      const path = rest.slice(1).join("/");
      if (!path) return err("missing_path", "Missing file path.", 400);
      const s = await stub.stat(path);
      if (!s) return json({ error: "not_found", path, docs: DOCS_URL, llms_txt: LLMS_TXT_URL }, 404, metaHeaders);
      return finalize(json({ sha, ...s }, 200, metaHeaders));
    }

    // -----------------------------------------------------------------
    // outline
    //
    //   /outline/<path>           file or directory
    //     ?depth=1|2              enumerate class/interface members at depth≥2
    //     ?comments=1             include leading JSDoc/`//`/`#` comments
    //
    // When path resolves to a directory, returns the bulk outline for every
    // source file under that prefix — equivalent to /tree.json?outlines=1
    // but with a shape focused on "give me everything in this folder".
    // -----------------------------------------------------------------
    if (action === "outline") {
      // Accept `path` as URL segment (`/outline/src/foo.ts`) OR as query param
      // (`?path=src/foo.ts`). Multiple agents tried the query form expecting
      // consistency with `/file?lines=`; we now honor both.
      let path = rest.slice(1).join("/");
      const outlinePathParam = readPathParam(url);
      if (outlinePathParam instanceof Response) return outlinePathParam;
      if (outlinePathParam) {
        if (path) {
          return err(
            "conflicting_path",
            "Use /outline/<path> OR ?path=<path>, not both.",
            400,
            { urlPath: path, queryPath: outlinePathParam.path },
          );
        }
        path = outlinePathParam.path;
      }
      if (!path) return err("missing_path", "Missing file path.", 400);

      const depthRaw = url.searchParams.get("depth");
      const depth = depthRaw ? Math.min(Math.max(1, Number(depthRaw)), 3) : 1;
      const wantComments = url.searchParams.get("comments") === "1";

      const file = await stub.read(path);
      if (!file) {
        // If no exact-file match, check if `path` is a directory prefix and
        // emit a bulk outline for every file underneath. This is the shape
        // our test agents asked for ("outline everything in this folder").
        const probe = await stub.tree({ prefix: path });
        if (probe.length > 0) {
          const outlineOpts: { depth?: number; comments?: boolean; prefix: string } = { prefix: path };
          if (depth !== 1) outlineOpts.depth = depth;
          if (wantComments) outlineOpts.comments = wantComments;
          const { entries, truncated } = await stub.treeWithOutlines(outlineOpts);
          const headers: Record<string, string> = { ...metaHeaders };
          if (truncated) headers["x-gitvfs-truncated"] = "true";
          return finalize(json(
            { sha, path, kind: "directory", count: entries.length, truncated, entries },
            200, headers,
          ));
        }
        const suggestions = await stub.suggestPaths(path);
        return json(
          { error: "not_found", path, suggestions, docs: DOCS_URL, llms_txt: LLMS_TXT_URL },
          404,
          metaHeaders,
        );
      }

      const decoder = new TextDecoder("utf-8", { fatal: false });
      const body = decoder.decode(file.content);
      const outlineOpts: { depth?: number; comments?: boolean } = {};
      if (depth !== 1) outlineOpts.depth = depth;
      if (wantComments) outlineOpts.comments = wantComments;
      const o = outline(path, body, outlineOpts);
      return finalize(json({ sha, kind: "file", ...o }, 200, metaHeaders));
    }

    // -----------------------------------------------------------------
    // grep
    // -----------------------------------------------------------------
    if (action === "grep") {
      const q = url.searchParams.get("q");
      if (q === null || q === "") return err("missing_q", "Missing ?q=<pattern>.", 400);
      // Stricter per-IP cap for expensive endpoints, layered over the
      // cheap general gate that ran in the outer envelope. Skipped for
      // internal bypass-key traffic.
      if (!internalBypass) {
        const ipBlock = await rateLimit(env.RL_EXPENSIVE, clientIp(request), "grep");
        if (ipBlock) return ipBlock;
      }
      const gate = await stub.checkThrottle("grep");
      if (!gate.allowed) {
        return throttled(
          "rate_limited",
          `Too many grep/bash calls on ${owner}/${repo}@${sha.slice(0, 7)} in the last minute.`,
          gate.retryAfterSec ?? 10,
          { sha, kind: "grep" },
        );
      }
      const rawGlob = url.searchParams.get("glob");
      if (rawGlob === "") return err("bad_glob", "Empty glob.", 400);
      let glob = rawGlob ? normalizeGlob(rawGlob) : undefined;
      // Bash-style `path=` scoping. Agents write `?path=src/foo.ts` by analogy
      // with `grep pattern src/foo.ts` — we translate to a glob that matches
      // the exact file OR anything beneath that prefix as a directory.
      const grepPathParam = readPathParam(url);
      if (grepPathParam instanceof Response) return grepPathParam;
      if (grepPathParam) {
        const pathPrefix = grepPathParam.path;
        // Matches both the literal path (file or dir itself) and `path/...`
        // (descendants). SQLite GLOB `*` spans `/`, so `prefix*` works for
        // both cases after normalization.
        const pathGlob = `${pathPrefix}*`;
        glob = glob ? `${glob}` : pathGlob;
        // If the user passed BOTH glob and path, AND both, logically.
        // We do that by appending path as a second pass exclude-nothing AND.
        // Simpler: just fold pathGlob in when no explicit glob is set.
        if (rawGlob) {
          // Both given: narrow to intersection by letting SQL do two matches.
          // We accomplish this via excludeGlob on anything NOT matching the path.
          // (The DO's grep supports multiple exclude_globs but not an AND of
          // includes.) Simplest correct behavior: refuse this combo for now.
          return err(
            "conflicting_path",
            "Use ?glob=... OR ?path=..., not both.",
            400,
            { glob: rawGlob, path: pathPrefix },
          );
        }
        glob = pathGlob;
      }
      const excludeGlob = url.searchParams.getAll("exclude_glob").map(normalizeGlob);
      const caseParam = url.searchParams.get("case") ?? "";
      const caseInsensitive = caseParam === "i" || caseParam === "1";
      const regex = url.searchParams.get("regex") === "1";
      const word = url.searchParams.get("word") === "1";
      const filesOnly = url.searchParams.get("files_only") === "1" || url.searchParams.get("filesOnly") === "1";
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Number(limitRaw) : 200;
      if (limitRaw && (!Number.isFinite(limit) || limit <= 0)) {
        return err("bad_limit", `Invalid limit: ${limitRaw}`, 400);
      }
      const context = Number(url.searchParams.get("context") ?? "0") || 0;
      const format = url.searchParams.get("format") ?? "json";

      // Validate regex up-front so callers get a 400 on bad patterns.
      if (regex) {
        try { new RegExp(q); } catch (e: any) {
          return err("bad_regex", `Invalid regex: ${e?.message ?? String(e)}`, 400);
        }
      }
      if (glob === "") return err("bad_glob", "Empty glob.", 400);

      const result = await stub.grep({
        q, glob, excludeGlob, caseInsensitive, regex, word, limit, context, filesOnly,
      });

      if (filesOnly) {
        if (format === "text" || format === "grep") {
          const body = (result.files ?? []).join("\n");
          return finalize(text(body + (result.files?.length ? "\n" : ""), 200, metaHeaders));
        }
        return finalize(json({
          sha, q,
          truncated: result.truncated,
          filesScanned: result.filesScanned,
          matchedFiles: result.matchedFiles,
          count: result.files?.length ?? 0,
          files: result.files ?? [],
        }, 200, metaHeaders));
      }

      // AS-005: ?symbols=1 annotates each match with its enclosing top-level
      // symbol name (function/class/method/export). Saves the agent a
      // follow-up `/outline` call when grep already identifies the region.
      // We outline each distinct matched path at most once per request.
      const wantSymbols = url.searchParams.get("symbols") === "1";
      type AnnotatedMatch = typeof result.matches[number] & { inSymbol?: string };
      let annotatedMatches: AnnotatedMatch[] = result.matches;
      if (wantSymbols && result.matches.length > 0) {
        const byPath = new Map<string, typeof result.matches>();
        for (const m of result.matches) {
          const arr = byPath.get(m.path) ?? [];
          arr.push(m);
          byPath.set(m.path, arr);
        }
        annotatedMatches = [...result.matches];
        const decoder = new TextDecoder("utf-8", { fatal: false });
        for (const [p] of byPath) {
          const f = await stub.read(p);
          if (!f) continue;
          const o = outline(p, decoder.decode(f.content), { depth: 2 });
          // Flatten items + children so we can match inside class members too.
          const flat: { name: string; line: number; endLine?: number }[] = [];
          const pushFlat = (it: any) => {
            flat.push({ name: it.name, line: it.line, endLine: it.endLine });
            if (Array.isArray(it.children)) for (const c of it.children) pushFlat(c);
          };
          for (const it of o.items) pushFlat(it);
          // Sort by line ascending for linear lookup.
          flat.sort((a, b) => a.line - b.line);
          for (const m of annotatedMatches) {
            if (m.path !== p) continue;
            // Innermost symbol that encloses this match line.
            let best: typeof flat[number] | undefined;
            for (const s of flat) {
              if (s.line > m.line) break;
              const end = s.endLine ?? Infinity;
              if (m.line <= end) best = s;
            }
            if (best) (m as AnnotatedMatch).inSymbol = best.name;
          }
        }
      }

      if (format === "text" || format === "grep") {
        const body = annotatedMatches
          .map((m) => `${m.path}:${m.line}:${m.text}`)
          .join("\n");
        return finalize(text(body + (annotatedMatches.length ? "\n" : ""), 200, {
          ...metaHeaders,
          "x-gitvfs-truncated": String(result.truncated),
          "x-gitvfs-files-scanned": String(result.filesScanned),
          "x-gitvfs-matched-files": String(result.matchedFiles),
        }));
      }
      return finalize(json({
        sha, q,
        truncated: result.truncated,
        filesScanned: result.filesScanned,
        matchedFiles: result.matchedFiles,
        count: annotatedMatches.length,
        matches: annotatedMatches,
      }, 200, metaHeaders));
    }

    // -----------------------------------------------------------------
    // symbol — return a single named symbol from a file.
    //
    //   GET /:owner/:repo[@:ref]/symbol/<path>?name=<symbol>
    //
    // AS-008: collapses the common "where is foo defined in bar.ts" pattern
    // to a single request. Same parse as /outline?depth=2, filtered server-side.
    // -----------------------------------------------------------------
    if (action === "symbol") {
      const symPath = rest.slice(1).join("/");
      if (!symPath) return err("missing_path", "Missing file path.", 400);
      const name = url.searchParams.get("name");
      if (!name) {
        return err(
          "missing_name",
          "Missing ?name=<symbol>. Example: /symbol/src/foo.ts?name=myFunc",
          400,
        );
      }
      const f = await stub.read(symPath);
      if (!f) {
        const suggestions = await stub.suggestPaths(symPath);
        return json(
          { error: "not_found", path: symPath, suggestions, docs: DOCS_URL, llms_txt: LLMS_TXT_URL },
          404,
          metaHeaders,
        );
      }
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const o = outline(symPath, decoder.decode(f.content), { depth: 2 });
      const flat: Array<{
        name: string; line: number; endLine?: number; kind: string; signature?: string;
      }> = [];
      const pushFlat = (it: any) => {
        flat.push({
          name: it.name, line: it.line, endLine: it.endLine,
          kind: it.kind, signature: it.signature,
        });
        if (Array.isArray(it.children)) for (const c of it.children) pushFlat(c);
      };
      for (const it of o.items) pushFlat(it);
      const match = flat.find((s) => s.name === name);
      if (!match) {
        // Closest-name suggestions: Levenshtein on names.
        const all = [...new Set(flat.map((s) => s.name))];
        const dist = (a: string, b: string): number => {
          const m = a.length, n = b.length;
          if (!m || !n) return Math.max(m, n);
          const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
          for (let i = 0; i <= m; i++) dp[i][0] = i;
          for (let j = 0; j <= n; j++) dp[0][j] = j;
          for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
              ? dp[i - 1][j - 1]
              : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
          }
          return dp[m][n];
        };
        const suggestions = all
          .map((n) => ({ n, d: dist(n.toLowerCase(), name.toLowerCase()) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 5)
          .map((x) => x.n);
        return json(
          {
            error: "symbol_not_found",
            path: symPath, name,
            suggestions,
            totalSymbols: flat.length,
            docs: DOCS_URL, llms_txt: LLMS_TXT_URL,
          },
          404,
          metaHeaders,
        );
      }
      return finalize(json(
        { sha, path: symPath, ...match, language: o.language },
        200, metaHeaders,
      ));
    }

    // -----------------------------------------------------------------
    // bash — read-only shell-ish runner over this repo.
    //
    //   GET /:owner/:repo[@:ref]/bash?cmd=<script>[&format=json|text]
    //
    // Supports a single pipeline of these commands: echo, ls, cat, head,
    // tail, wc, grep, find, sort, uniq, sed. See src/bash.ts for the exact
    // subset of flags. Writes and network are intentionally unimplemented.
    // -----------------------------------------------------------------
    if (action === "bash") {
      const cmd = url.searchParams.get("cmd");
      if (cmd === null || cmd === "") {
        return err(
          "missing_cmd",
          "Missing ?cmd=<script>. Example: ?cmd=" + encodeURIComponent("ls src | head"),
          400,
        );
      }
      // /bash is the CPU outlier — keep it on the stricter per-IP gate
      // (RL_EXPENSIVE, 30/10s) plus a tight 3s default / 5s max timeout.
      // Internal-key traffic still skips the per-IP cap but not the
      // per-SHA throttle below (defense against our own runaway benches).
      if (!internalBypass) {
        const ipBlock = await rateLimit(env.RL_EXPENSIVE, clientIp(request), "bash");
        if (ipBlock) return ipBlock;
      }
      const gate = await stub.checkThrottle("bash");
      if (!gate.allowed) {
        return throttled(
          "rate_limited",
          `Too many grep/bash calls on ${owner}/${repo}@${sha.slice(0, 7)} in the last minute.`,
          gate.retryAfterSec ?? 10,
          { sha, kind: "bash" },
        );
      }
      const format = url.searchParams.get("format") ?? "json";
      const timeoutRaw = url.searchParams.get("timeout_ms");
      // Default 3s, max 5s. Down from 15s — bash is the CPU outlier and a
      // 15s wall-clock budget was the largest single $ exposure per call.
      const timeoutMs = timeoutRaw ? Math.min(Math.max(100, Number(timeoutRaw)), 5_000) : 3_000;

      const r = await stub.bash(cmd, timeoutMs !== undefined ? { timeoutMs } : {});
      const bashStatus =
        r.exitCode === 0 ? 200
          : r.exitCode === 124 ? 504
            : r.exitCode === 127 ? 400
              : 422;
      const bashHeaders: Record<string, string> = {
        ...metaHeaders,
        "x-gitvfs-exit-code": String(r.exitCode),
        "x-gitvfs-duration-ms": String(Math.round(r.durationMs)),
      };
      if (r.truncated) bashHeaders["x-gitvfs-truncated"] = "true";

      if (format === "text" || format === "plain" || format === "raw") {
        // Shell-style: stdout to body, stderr appended after a separator if present.
        let body =
          r.stdout +
          (r.stderr
            ? (r.stdout && !r.stdout.endsWith("\n") ? "\n" : "") + r.stderr
            : "");
        // Disambiguate "truly empty" vs "broken" for agents that don't read
        // headers: on non-zero exit with no output, surface the exit code
        // inline. (Successful empty output — e.g. echo -n "" — stays empty.)
        if (body === "" && r.exitCode !== 0) {
          body = `# bash: exit=${r.exitCode}, no output (${Math.round(r.durationMs)}ms)\n`;
        }
        return finalize(text(body, bashStatus, bashHeaders));
      }
      const jsonBody = r.exitCode === 0
        ? { sha, ...r }
        : {
            error: "bash_exit_nonzero",
            message: `Command exited with code ${r.exitCode}.`,
            sha,
            ...r,
            docs: DOCS_URL,
            llms_txt: LLMS_TXT_URL,
          };
      return finalize(json(jsonBody, bashStatus, bashHeaders));
    }

    return err("unknown_action", `Unknown action: ${action}`, 404);
}
