# gitvfs

Instant HTTP VFS over any public GitHub repo. Agent-friendly by design.

Replace `github.com` with this host and `curl` it. No setup, no auth for public repos, no git clone.

```bash
curl https://gitvfs.miryaboy.workers.dev/facebook/react/tree?depth=1
curl https://gitvfs.miryaboy.workers.dev/facebook/react/outline/packages/react/src/ReactHooks.js
curl 'https://gitvfs.miryaboy.workers.dev/facebook/react/grep?q=useEffect&files_only=1'
curl 'https://gitvfs.miryaboy.workers.dev/pingdotgg/t3code/file/apps/server/src/provider/Layers/CursorAdapter.ts?lines=696-781'
```

Landing page at `/` (human-readable) and `/llms.txt` (machine-readable, for agents).

## Endpoints

| Endpoint | What it does |
|---|---|
| `GET /tree[/<path>]` | File listing; `?depth=1` for one-level (ls-style) |
| `GET /tree.json[/<path>]` | Structured listing; `?outlines=1` adds per-file symbols |
| `GET /file/<path>` | Raw bytes; `?lines=A-B` for slices |
| `GET /files?paths=a&paths=b` | Batched read, up to 50 files |
| `GET /stat/<path>` | `{size, mime, lines, language}` |
| `GET /outline/<path>` | Top-level symbols (+ `endLine`, `?depth=2` for members, `?comments=1` for JSDoc) |
| `GET /outline/<dir>` | Bulk outline for every file under a directory |
| `GET /grep?q=<pat>` | ripgrep-like search |
| `GET /bash?cmd=<script>` | Read-only shell pipeline (echo, ls, cat, head, tail, wc, grep, find, sort, uniq, sed); non-zero exits return non-2xx plus `x-gitvfs-exit-code` |
| `GET /head` | Freshness probe: resolves ref → SHA without ingesting |
| `GET /status` | Ingest state for the current `owner/repo@sha` |

Every response carries `x-gitvfs-sha`, `x-gitvfs-ref`, `x-gitvfs-resolved-at`, `x-gitvfs-age-seconds`, `x-gitvfs-duration-ms`, and `x-gitvfs-source` (`edge` | `do`) headers. `/file` responses additionally carry `x-gitvfs-lines` and `x-gitvfs-language`. File line counts are logical line counts: a trailing final newline does not create a phantom blank line, and `/file?lines=...` past EOF returns `416 line_range_not_satisfiable`.

## For agents

Use curl or any raw HTTP client. **Do NOT use summarizing fetchers** (Claude Code's WebFetch, ChatGPT browsing, etc.) — they paraphrase source code back to you instead of returning it.

Recommended exploration loop, based on subagent studies:

1. `/outline/<path>` — pick the symbol you care about
2. `/file/<path>?lines=A-B` — read just that function (use `endLine` from step 1)
3. Repeat or fall back to `/grep` / `/bash`

Fetch `/llms.txt` at the base URL for a compact, machine-friendly catalog.

## Architecture

- **Cloudflare Worker** serves HTTP, parses URLs, coordinates with DOs, caches at the edge.
- **Durable Object per `(owner, repo, sha)`** holds the repo's files in embedded sqlite. One DO per commit; self-evicts 7 days after last access via Alarms.
- **First request** for a new SHA pays ~1–30s cold ingest (stream tarball from GitHub, parse, skip binaries/lockfiles, insert rows). Subsequent requests are ~25–80ms warm, ~15ms edge-cached.
- **No persistent global state** — each unique commit is independent. Easy to scale, simple to reason about.

## Operational

- `GITHUB_TOKEN` secret: 5000 req/hr to GitHub API (vs 60 unauthenticated). Set via `wrangler secret put GITHUB_TOKEN`.
- `GITVFS_INTERNAL_KEY` secret: the `X-Gitvfs-Key` header bypasses per-IP rate limits for internal tooling (tests, bench, MCP wrapper).
- Rate limits (per client IP): 30/10s on `/bash` + `/grep`, 100/10s on everything else. Returns 429 with `retry-after`.
- CORS supports `GET`, `HEAD`, and `OPTIONS`; preflight requests return metadata without executing repo routes.
- Workers Logs enabled (`[observability]` in `wrangler.toml`) — structured JSON access log per request, searchable + alertable from the dashboard.
- Workers Analytics Engine dataset `gitvfs_metrics` — per-request `{action, source, status, durationMs}`.
- DO TTL: 7 days (idle → self-evict via alarm → re-ingest on next request).

## Development

```bash
bun install
bun test                 # 130+ tests (local unit + live integration)
bun bench:worker         # end-to-end latency bench against deployed worker
bunx wrangler dev        # local dev server
bunx wrangler deploy     # push to prod
```

Local `.env` (gitignored) for tests + bench:

```
GITVFS_INTERNAL_KEY=<same value as the deployed secret>
GITHUB_TOKEN=<optional, for dev>
```

Bench baseline at `bench/results/baseline.json`. Compare future runs against it to catch latency regressions.

## License

MIT.
