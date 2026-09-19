# Functionality

This file is the living functional spec for `instant-vfs`. The code remains the source of truth; update this file when finalized behavior changes.

## GitVFS HTTP API

`instant-vfs` exposes public GitHub repositories through read-only HTTP endpoints on `gitvfs.miryaboy.workers.dev`.

### Existing Behavior

- `GET /` uses content negotiation: browser requests that accept `text/html` receive a minimal human landing page, while raw clients receive the complete plain-text agent guide. `?format=html` and `?format=text` provide explicit overrides.
- The human landing page explains the product in plain language, accepts a public GitHub repository URL, generates a copyable agent prompt, and links directly to the complete `/llms.txt` instructions.
- The generated prompt tells an agent to read `/llms.txt`, use structured discovery endpoints before narrow file reads, and pin a full SHA when reproducibility matters.
- `GET /:owner/:repo[@:ref]/file/<path>` returns raw file bytes. `?lines=A-B` returns an inclusive logical line slice, and `?numbered=1` prefixes rendered lines with `N | `.
- File line counts are logical line counts. A trailing final newline terminates the last content line and does not create a phantom blank line.
- `/file`, `/stat`, `/outline`, `HEAD /file`, and `?lines=` metadata must agree on the same logical total line count.
- A valid `?lines=` range that starts after the end of the file returns `416` with `error: "line_range_not_satisfiable"` and the file's `totalLines`.
- The HTTP API accepts only `GET`, `HEAD`, and `OPTIONS`. `POST`, `PUT`, `PATCH`, `DELETE`, and other unsupported methods return `405 method_not_allowed` with `Allow: GET, HEAD, OPTIONS` before repo routing, ref resolution, caching, Durable Object access, or rate limiting.
- CORS advertises `GET`, `HEAD`, and `OPTIONS`. `OPTIONS` preflight requests return CORS metadata without resolving refs, hitting Durable Objects, rate-limiting as a repo request, or returning route bodies.
- `/bash?cmd=...` runs a read-only shell-shaped pipeline against the repo and always reports the shell exit code in `x-gitvfs-exit-code`.
- `/bash` returns HTTP `200` for exit code `0`, `400` for unknown commands (`127`), `504` for timeouts (`124`), and `422` for other non-zero command exits.

### Rules And Constraints

- The browser landing page is self-contained HTML, CSS, and JavaScript with no framework or asset dependency; the API remains usable when browser JavaScript is disabled.
- Plain-text root responses retain the exact end-of-document sentinel and full endpoint reference so existing curl and agent workflows do not regress.
- Supported `/bash` commands remain read-only: `echo`, `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `find`, `sort`, `uniq`, and `sed`.
- `/bash` non-zero responses preserve stdout/stderr in text mode so shell-like callers can inspect the failure body while also relying on HTTP status.
- `/bash` non-zero responses are not cacheable and must carry `cache-control: no-store`.
- `?lines=` accepts only `N` or `A-B` positive integer syntax. Malformed ranges return `400 bad_lines`; ranges with `end < start` also return `400 bad_lines`.
- Empty files have `0` logical lines.

### Edge Cases

- An explicit `?format=text` wins over a browser `Accept: text/html` header, and `?format=html` wins over a raw-client `Accept` header.
- An empty or malformed repository field leaves a usable generic prompt instead of generating a broken gitvfs URL.
- `Hello World!\n` has exactly one logical line. `?lines=1` returns `Hello World!`; `?lines=2` returns `416 line_range_not_satisfiable`.
- Whole-file numbered output for a trailing-newline file must not append a blank numbered line.
- CORS preflight with custom requested headers echoes those requested headers in `access-control-allow-headers`.
- Unsupported methods receive the same security and CORS headers as other API errors, but no repository metadata because routing never runs.
- A supported command with no matches, such as `grep` returning exit code `1`, is a completed shell command but still maps to HTTP `422`.

### Testing Notes

- Integration-test `/` with browser and raw-client `Accept` headers plus both `format` overrides; assert content types, `Vary: Accept`, the human copy controls, and the unchanged plain-text sentinel.
- Browser-test prompt generation and copy feedback with empty, `owner/repo`, normal GitHub URL, and `.git` URL inputs at desktop and mobile widths.
- Unit-test the outline extractor with trailing-newline and empty-file inputs.
- Integration-test `octocat/Hello-World` through `/file?lines=1`, `/file?lines=2`, `/file?numbered=1`, `/stat`, and `/outline` to prove line-count consistency.
- Integration-test `OPTIONS` with `Origin`, `Access-Control-Request-Method`, and `Access-Control-Request-Headers`; assert status `204`, no body, CORS headers, and no route body.
- Integration-test `POST`, `PUT`, `PATCH`, and `DELETE` against a valid repository route; assert `405 method_not_allowed`, the canonical `Allow` header, matching CORS method metadata, and no `x-gitvfs-sha` route metadata.
- Integration-test `/bash?format=text&cmd=touch%20x` returns `400` with `x-gitvfs-exit-code: 127`.
- Integration-test a no-match `/bash` grep returns `422` with the empty-output footer and `x-gitvfs-exit-code: 1`.

## Semantic Endpoints (TypeSafe Jev)

`src/semantic.ts` adds judgment on top of the lexical VFS. `src/jev.ts` is the TypeSafe client. The worker adapts its Durable Object stub to the `Source` interface; `bench/semantic-try.ts` adapts the public HTTP API so the same code runs locally.

### Existing Behavior

- `GET /find?q=<question>` combines a path-name judgment (one Choice over all paths for repos ≤220 files, beam search over directory levels computed in memory otherwise), paths whose segments literally contain a question term, a literal grep of the question's quoted strings and code-shaped identifiers, and lines that contain two or more of its plain words, then outlines of the resulting files, into ≤255 candidates (`file`, `symbol`, or `match` kinds). One Choice ranks the candidates and one Noul (`exists`) says whether the repo plausibly contains the answer. When the top probability is below 0.75, the top three files (≤1200 lines each) are read line by line (`locate`) and the judgment is repeated with the best lines added (`stages.final.deepened`). Hits carry `probability`, a numbered `snippet`, and a ready `next` URL pinned to the SHA. The top hit's `source` (≤80 lines) is inlined automatically when its probability is ≥0.8; `?read=1` (or `/ask`) forces it (≤200 lines) and `?read=0` suppresses it. `?limit=` caps hits (max 20).
- `GET /file/<path>?about=<question>` (alias `/locate/<path>?q=`) ranks lines inside one file: windows of 150 lines, one Choice over line ids and one Noul per window, at most 4000 lines scanned (`scanned` reports the range). Returns `hits`, `exists`, and a `slice` around the best line (`?context=`, default 3).
- `GET /grep?q=&intent=<question>` reranks up to 160 matches with one Noul each (batched 80 per model call). Implies `context=2` and `symbols=1`. JSON adds `intent`, `ranked`, `rankedMatches`, `best`, and `relevance` per match; text format prefixes each line with the relevance. `files_only=1` with `intent` is `400 bad_params`.
- `GET /verify/<path>?lines=A-B&claim=<text>` returns `supported` (Noul), `verdict` (`supported` | `contradicted` | `unrelated`), `confidence`, and `probabilities`. Max 400 lines and 1000-char claims.
- `GET /tree[.json]?roles=1` tags each entry with one of the ROLES (entrypoint, core, api, ui, types, util, config, build, ci, tests, docs, examples, data, assets, generated, scripts) and `roleConfidence` (JSON) or a trailing tab column (text). Works on `?depth=1` and flat listings ≤400 entries (`400 too_many_entries` beyond).
- `400 unknown_query_param` on `/tree` asks Jev which known param was meant and, when confident (≥0.5), includes `suggested`, a corrected URL.
- Every semantic response carries `x-gitvfs-jev-requests`, `x-gitvfs-jev-tokens`, `x-gitvfs-jev-ms`, `x-gitvfs-jev-model`, and `x-gitvfs-semantic-cache` (`hit` | `miss`). `/find` adds `x-gitvfs-exists` and `x-gitvfs-confidence`; `/verify` adds `x-gitvfs-verdict`.
- Answers are cached in the per-SHA Durable Object (`semantic_cache` table, keyed by endpoint + every input) and evicted with the repo; successful GETs are also edge-cached like every other route.

### Rules And Constraints

- Semantic routes share the `/bash` + `/grep` rate limits (`RL_EXPENSIVE`, 30/10s per IP) and the per-SHA throttle. Internal-key traffic skips the per-IP cap only.
- Without `TYPESAFE_API_KEY`: `/find`, `/ask`, `/locate`, `/verify`, and `/file?about=` return `503 semantic_unavailable`; `?intent=` and `?roles=1` return the lexical result with `x-gitvfs-semantic: unavailable`. A model failure returns `502 semantic_upstream_failed` (`429` when the model rate-limits) for the dedicated routes and `x-gitvfs-semantic: failed` with the lexical result for the params.
- Candidate sets are sized to Jev's limits (255 Choice options, ~30k state tokens); the code trims before asking, never after.
- Probabilities are the model's own and are returned unmodified (rounded to 3 decimals); thresholds live in the caller.

### Edge Cases

- A `find` question with no code-shaped tokens still works from path names alone; a question whose tokens grep nothing still gets path candidates.
- A grep hit on the same line as a symbol is folded into the symbol candidate.
- `/find` on an empty repo returns `hits: []`, `exists: 0`.
- `?about=` on a file longer than 4000 lines scans the first 4000 and reports it in `scanned`.

### Testing Notes

- Unit-test `planQuery` (quoted literals, camelCase, snake_case, file.ext, stopwords).
- Integration-test `/find` on pinned `honojs/hono` and `sst/opencode` commits: expected path in the top hit, `exists` high, headers present, second call `x-gitvfs-semantic-cache: hit` with zero Jev requests.
- Integration-test `/verify` with a true and a false claim on `package.json`.
- Integration-test `?intent=` orders the definition line first for `bodyLimit`; `files_only=1&intent=` is 400.
- Integration-test `?roles=1` on hono root: `src/` is `core`, `.github/` is `ci`, `bun.lock` is `generated`.
- Integration-test `/tree?subpath=x` returns `suggested`.

## Agent Benchmark Harness

`bench/agents/bench.ts` runs paired agent evaluations that compare normal GitHub access against gitvfs-assisted access.

### Existing Behavior

- Each benchmark job asks the same factual repository question under one of two conditions:
  - `baseline`: the model is told to use GitHub rendered pages, raw GitHub files, or the GitHub REST API.
  - `gitvfs`: the model is additionally told to use `https://gitvfs.miryaboy.workers.dev` endpoints.
- Every job exposes exactly one model tool, `http_get(url)`, which fetches a URL with raw `fetch`, follows redirects, and returns status, content type, byte count, elapsed fetch time, and the first 50,000 response bytes to the model.
- The harness records one `RunSummary` JSONL row per task, condition, and trial in `bench/agents/results/runs.jsonl`.
- The harness records one trace JSONL file per run under `bench/agents/results/traces/`, including URL, status, elapsed time, byte counts, response content type, gitvfs response headers, and the same capped response body the agent saw.
- Tasks live in `bench/agents/tasks.jsonl` and use deterministic expected-answer graders: exact match, regex, or contains-all.
- Each benchmark invocation writes a Markdown report in `bench/agents/results/<benchRunId>-report.md`.
- Each run summary is tagged with the current git commit, dirty-worktree status, provider, model, note, cost source, token usage, wall-clock time, tool calls, stop reason, and pass/fail result.

### Rules And Constraints

- Default execution runs both conditions for every selected task with one trial.
- `--task <id>`, `--condition <baseline|gitvfs>`, `--trials <n>`, `--provider <anthropic|openrouter>`, `--model <name>`, `--note <text>`, and `--concurrency <n>` scope or annotate a run.
- The default Anthropic model is `claude-sonnet-4-5`; the default OpenRouter model is `minimax/minimax-m2.5`.
- Anthropic requires `ANTHROPIC_API_KEY`; OpenRouter requires `OPENROUTER_API_KEY`.
- If `GITVFS_INTERNAL_KEY` is present, gitvfs requests include `x-gitvfs-key` to avoid per-IP rate-limit noise during concurrent benchmark runs.
- Tool response bodies are capped at 50,000 bytes. The trace body cap intentionally matches the model-visible cap so traces reproduce the evidence the model saw.
- The benchmark uses raw HTTP, not summarizing fetchers, so URL parameters and response bodies are not paraphrased before reaching the model.
- `bench/agents/results/` is intentionally git-tracked because benchmark history is part of the measurement record.

### Edge Cases

- Network or model errors produce a failed `RunSummary` stub with `stopReason: "error"` and zero token/cost metrics rather than dropping the row.
- Non-2xx HTTP responses are still returned to the model and trace with their status and body.
- OpenRouter-reported usage cost is preferred when available; otherwise the harness computes cost from the local pricing table.
- Concurrent runs make absolute wall-clock timings noisier, but paired baseline/gitvfs comparisons remain useful because both conditions run under the same contention.
- Baseline runs can be noisy and model-memory leakage is possible on popular public repos; use multiple trials when small effects matter.

### Testing Notes

- Unit-test grading with exact, regex, and contains-all expected-answer shapes.
- Integration-test a single-task, single-condition run with a mocked Anthropic-compatible client and mocked `fetch`, asserting `runs.jsonl`, trace JSONL, and report output are created.
- Test that `http_get` caps model-visible bodies and trace bodies at the same byte limit while preserving total byte count and truncation metadata.
- Test that gitvfs URLs receive `x-gitvfs-key` only when `GITVFS_INTERNAL_KEY` is set and the URL host is gitvfs.
- Test error handling by forcing the model call and fetch call to fail; each should produce inspectable failure output without corrupting existing result files.

## PR Review Pages

Every PR should include a deployed `PR.html` review page on `here.now`.

### Existing Expectation

- `PR.html` should explain what changed, include Mermaid diagrams where they clarify architecture or flow, and present review-relevant code or diffs.
- The page should use a two-column layout: explanations and diagrams on the left, implementation details on the right.

### Testing Notes

- For PRs with UI or architecture changes, open the deployed `PR.html` and verify the page renders, diagrams display, and both columns remain readable on desktop and mobile widths.
