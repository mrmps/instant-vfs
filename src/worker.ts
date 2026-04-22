import { RepoDO, type Env, type RateLimiterBinding } from "./repo-do";
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

export { RepoDO };

// Security + ergonomics headers applied to every response. These are safe
// defaults for a read-only service over public repos.
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

// Every 4xx/5xx error body gets these links. Agents (and humans) hitting an
// unknown endpoint get a direct pointer to the full documentation without
// having to guess the base URL.
const DOCS_URL = "https://gitvfs.miryaboy.workers.dev/";
const LLMS_TXT_URL = "https://gitvfs.miryaboy.workers.dev/llms.txt";

function json(data: unknown, status = 200, extra: HeadersInit = {}) {
  const base: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    ...SECURITY_HEADERS,
  };
  if (status >= 400) base["cache-control"] = "no-store";
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...base, ...Object.fromEntries(new Headers(extra)) },
  });
}

function text(body: string, status = 200, extra: HeadersInit = {}) {
  const base: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*",
    ...SECURITY_HEADERS,
  };
  if (status >= 400) base["cache-control"] = "no-store";
  return new Response(body, {
    status,
    headers: { ...base, ...Object.fromEntries(new Headers(extra)) },
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
/bash is an escape hatch for ad-hoc multi-step shell pipelines.

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
x-gitvfs-lines         file line count (on /file, /stat, HEAD /file)
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

For agents

  Use curl (or any raw HTTP client) — not a summarizing fetcher.
  Tools that paraphrase fetched URLs (e.g. Claude Code's WebFetch,
  ChatGPT browsing) will return a natural-language summary of the
  source instead of the code itself. gitvfs also ships extra context
  via response headers (line counts, language, SHA, freshness) that
  only survive in a raw HTTP response.

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
       &timeout_ms=5000                      cap wall-clock (max 15000)
    Runs a read-only shell pipeline against the repo. Supports:
      echo, ls, cat, head, tail, wc, grep, find, sort, uniq, sed
    Pipelines with '|' work. Variables, redirections, loops, writes,
    and network are not supported.

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
    x-gitvfs-lines         total line count for the file
    x-gitvfs-language      detected language (typescript, go, python, …)
    x-gitvfs-total-lines   present on ?lines=… slices so you know the full size
    x-gitvfs-line-range    the effective range you got back

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

Notes

  · First request for a repo takes a few seconds (tarball ingest); cached after.
  · Source only — binaries, node_modules, lockfiles, build output skipped.
  · Ref = branch, tag, or full 40-char SHA. Default = default branch.
  · Short SHAs are resolved against GitHub; only full SHAs get long-term cache.
  · Very large repos (>~50k files) may exceed the Worker CPU budget on first ingest.
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
      const block = bypass
        ? null
        : await rateLimit(env.RL_GENERAL, clientIp(request), "general");
      resp = block ?? await handle(request, env, ctx, url, pathname, bypass);
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
    if (env.METRICS) {
      try {
        env.METRICS.writeDataPoint({
          blobs: [action, source, String(out.status)],
          doubles: [durationMs],
          indexes: [action],
        });
      } catch {}
    }

    return out;
  },
};

// Bucket the pathname into a low-cardinality action name for metrics.
// Avoids emitting one metric series per unique repo/path.
function endpointBucket(pathname: string): string {
  if (pathname === "/" || pathname === "") return "landing";
  if (pathname === "/llms.txt" || pathname === "/.well-known/llms.txt") return "llms";
  if (pathname === "/health") return "health";
  if (pathname === "/favicon.ico" || pathname === "/robots.txt") return "static";
  const segs = pathname.split("/").filter(Boolean);
  // Expect at least /owner/repo/<action>. Fallback to "other" on noise.
  if (segs.length < 3) return "other";
  const action = segs[2].split("?")[0];
  if (ACTIONS.has(action)) return action;
  return "other";
}

async function handle(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  pathname: string,
  internalBypass: boolean,
): Promise<Response> {
    if (pathname === "/" || pathname === "") return text(landing(url.origin));
    if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (pathname === "/robots.txt") return text("User-agent: *\nDisallow:\n");
    if (pathname === "/health") return json({ ok: true });
    if (pathname === "/llms.txt" || pathname === "/.well-known/llms.txt") {
      return text(llmsTxt(url.origin));
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
        if (!s) return new Response(null, { status: 404, headers: metaHeaders });
        const headHeaders: Record<string, string> = {
          "content-type": s.mime + "; charset=utf-8",
          "content-length": String(s.size),
          "access-control-allow-origin": "*",
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
        const allLines = text_.split("\n");
        const start = Math.max(1, parseInt(m[1], 10));
        const end = m[2] ? parseInt(m[2], 10) : start;
        if (end < start) {
          return err("bad_lines", `Range ${start}-${end} is empty (end < start).`, 400);
        }
        const effEnd = Math.min(allLines.length, end);
        const sliceLines = allLines.slice(start - 1, effEnd);
        const body = numbered
          ? withLineNumbers(sliceLines, start)
          : sliceLines.join("\n");
        return finalize(new Response(body, {
          status: 200,
          headers: {
            "content-type": file.mime + "; charset=utf-8",
            "access-control-allow-origin": "*",
            "x-gitvfs-line-range": `${start}-${effEnd}`,
            "x-gitvfs-total-lines": String(allLines.length),
            "x-gitvfs-language": language,
            ...(numbered ? { "x-gitvfs-numbered": "1" } : {}),
            ...metaHeaders,
          },
        }));
      }

      // Whole-file path, optionally numbered.
      if (numbered) {
        const decoder = new TextDecoder("utf-8", { fatal: false });
        const allLines = decoder.decode(file.content).split("\n");
        const body = withLineNumbers(allLines, 1);
        return finalize(new Response(body, {
          status: 200,
          headers: {
            "content-type": file.mime + "; charset=utf-8",
            "access-control-allow-origin": "*",
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
          "access-control-allow-origin": "*",
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
            "access-control-allow-origin": "*",
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
      const timeoutMs = timeoutRaw ? Math.min(Math.max(100, Number(timeoutRaw)), 15_000) : undefined;

      const r = await stub.bash(cmd, timeoutMs !== undefined ? { timeoutMs } : {});
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
        return finalize(text(body, 200, bashHeaders));
      }
      return finalize(json({ sha, ...r }, 200, bashHeaders));
    }

    return err("unknown_action", `Unknown action: ${action}`, 404);
}
