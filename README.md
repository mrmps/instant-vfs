# gitvfs

Instant HTTP VFS over any public GitHub repo. Agent-friendly by design.

Replace `github.com` with this host and `curl` it. No setup, no auth for public repos, no git clone.

```bash
curl https://gitvfs.miryaboy.workers.dev/facebook/react/tree?depth=1
curl https://gitvfs.miryaboy.workers.dev/facebook/react/outline/packages/react/src/ReactHooks.js
curl 'https://gitvfs.miryaboy.workers.dev/facebook/react/grep?q=useEffect&files_only=1'
curl 'https://gitvfs.miryaboy.workers.dev/pingdotgg/t3code/file/apps/server/src/provider/Layers/CursorAdapter.ts?lines=696-781'
```

Browsers receive a minimal human landing page at `/`; raw clients receive the
full text guide from the same route. `/llms.txt` is the stable machine-readable
catalog for agents. Use `?format=html` or `?format=text` to select explicitly.

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

### Semantic endpoints

Judgment comes from [TypeSafe's Jev](https://docs.typesafe.ai), a decision model that returns calibrated probabilities in ~150ms. gitvfs does the lexical work (paths, grep, outlines) and asks Jev only the question that needs judgment. Answers are cached per `(sha, question)` inside the repo's Durable Object and at the edge.

| Endpoint | What it does |
|---|---|
| `GET /find?q=<question>` | "Where is X?" → ranked `{path, symbol, line, endLine, probability, snippet, next}` + `exists`; `&read=1` inlines the top hit |
| `GET /ask?q=<question>` | `/find?read=1`: the answer and its source in one call |
| `GET /file/<path>?about=<question>` | Ranked lines inside one file + `exists` + a slice (`/locate/<path>?q=` is an alias) |
| `GET /grep?q=<pat>&intent=<question>` | Grep whose matches are ordered by relevance to the intent |
| `GET /verify/<path>?lines=A-B&claim=<text>` | `supported` / `contradicted` / `unrelated` with probabilities |
| `GET /tree?depth=1&roles=1` | Each entry tagged `entrypoint`, `core`, `tests`, `docs`, `generated`, … |

Semantic responses add `x-gitvfs-jev-requests`, `x-gitvfs-jev-tokens`, `x-gitvfs-jev-ms` and `x-gitvfs-semantic-cache`. `/find` adds `x-gitvfs-exists` and `x-gitvfs-confidence`; `/verify` adds `x-gitvfs-verdict`. Unknown query params on `/tree` now come back with a `suggested` URL. Without `TYPESAFE_API_KEY` the semantic endpoints return `503 semantic_unavailable` and everything lexical is unchanged.

```bash
curl --get https://gitvfs.miryaboy.workers.dev/honojs/hono/find --data-urlencode 'q=where is the request body size limit enforced'
curl --get https://gitvfs.miryaboy.workers.dev/honojs/hono/ask --data-urlencode 'q=what is the version in package.json'
```

Every response carries `x-gitvfs-sha`, `x-gitvfs-ref`, `x-gitvfs-resolved-at`, `x-gitvfs-age-seconds`, `x-gitvfs-duration-ms`, and `x-gitvfs-source` (`edge` | `do`) headers. `/file` responses additionally carry `x-gitvfs-lines` and `x-gitvfs-language`. File line counts are logical line counts: a trailing final newline does not create a phantom blank line, and `/file?lines=...` past EOF returns `416 line_range_not_satisfiable`.

## For agents

Use curl or any raw HTTP client. **Do NOT use summarizing fetchers** (Claude Code's WebFetch, ChatGPT browsing, etc.) — they paraphrase source code back to you instead of returning it.

Recommended exploration loop:

1. `/find?q=<plain question>` — one call returns where it is, how sure we are, and the `next` URL to read
2. `/file/<path>?lines=A-B` — read just that (or skip this: `/ask?q=` inlines it)
3. `/verify/<path>?lines=A-B&claim=<your answer>` — check before you answer
4. Fall back to `/grep?intent=`, `/outline`, `/bash` when you already know the pattern

Fetch `/llms.txt` at the base URL for a compact, machine-friendly catalog.

## Benchmarks

`bench/agents/bench.ts` asks the same 15 factual questions (`bench/agents/tasks.jsonl`) under two conditions: plain GitHub (rendered pages, raw files, REST API) versus GitHub plus gitvfs. One tool, `http_get`. Measured 2026-09-19 with the semantic endpoints live; reports in `bench/agents/results/`.

| | Sonnet 4.5 baseline | Sonnet 4.5 + gitvfs | minimax-m2.5 baseline | minimax-m2.5 + gitvfs |
|---|---:|---:|---:|---:|
| Pass rate | 11/15 | **15/15** | 12/15 | **15/15** |
| Mean tool calls | 4.5 | **1.0** | 3.0 | **2.0** |
| Mean input tokens | 135,417 | **4,392** | 22,213 | **2,607** |
| Mean cost / task | $0.416 | **$0.016** | $0.0098 | **$0.0018** |
| Mean wall-clock | 20.2s | **5.9s** | 28.4s | **16.9s** |

With `/find` in front, Sonnet answered every task in exactly one tool call: the hit's snippet or inlined source already contained the answer. Baseline failures were all the same shape: a 1MB `git/trees` response or a 178KB HTML search page blew the context, followed by guessed raw-file URLs until the iteration cap.

## Architecture

- **Cloudflare Worker** serves HTTP, parses URLs, coordinates with DOs, caches at the edge.
- **Durable Object per `(owner, repo, sha)`** holds the repo's files in embedded sqlite, plus a `semantic_cache` table of Jev answers keyed by question. One DO per commit; self-evicts 7 days after last access via Alarms.
- **`src/semantic.ts` + `src/jev.ts`** turn lexical candidates (paths, grep hits, outline symbols) into ranked answers with one or two calls to TypeSafe's Jev. Candidate sets are sized to the model's limits (255 options per Choice) before asking; large repos use a beam search over directory levels computed in memory.
- Workers' embedded SQLite caps `LIKE`/`GLOB` patterns at ~50 bytes, so prefix scoping uses range comparisons on `path` and long user globs are evaluated in JS (AS-010).
- **First request** for a new SHA pays ~1–30s cold ingest (stream tarball from GitHub, parse, skip binaries/lockfiles, insert rows). Subsequent requests are ~25–80ms warm, ~15ms edge-cached.
- **No persistent global state** — each unique commit is independent. Easy to scale, simple to reason about.

## Operational

- `GITHUB_TOKEN` secret: 5000 req/hr to GitHub API (vs 60 unauthenticated). Set via `wrangler secret put GITHUB_TOKEN`.
- `TYPESAFE_API_KEY` secret: powers the semantic endpoints (key from console.typesafe.ai). Set via `wrangler secret put TYPESAFE_API_KEY`; put it in `.dev.vars` for `wrangler dev` and `.env` for `bench/semantic-try.ts`.
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
bun bench/semantic-try.ts tasks   # run every bench question through /find locally (needs TYPESAFE_API_KEY in .env)
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
