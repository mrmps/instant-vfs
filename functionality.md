# Functionality

This file is the living functional spec for `instant-vfs`. The code remains the source of truth; update this file when finalized behavior changes.

## GitVFS HTTP API

`instant-vfs` exposes public GitHub repositories through read-only HTTP endpoints on `gitvfs.miryaboy.workers.dev`.

### Existing Behavior

- `GET /:owner/:repo[@:ref]/file/<path>` returns raw file bytes. `?lines=A-B` returns an inclusive logical line slice, and `?numbered=1` prefixes rendered lines with `N | `.
- File line counts are logical line counts. A trailing final newline terminates the last content line and does not create a phantom blank line.
- `/file`, `/stat`, `/outline`, `HEAD /file`, and `?lines=` metadata must agree on the same logical total line count.
- A valid `?lines=` range that starts after the end of the file returns `416` with `error: "line_range_not_satisfiable"` and the file's `totalLines`.
- The HTTP API accepts only `GET`, `HEAD`, and `OPTIONS`. `POST`, `PUT`, `PATCH`, `DELETE`, and other unsupported methods return `405 method_not_allowed` with `Allow: GET, HEAD, OPTIONS` before repo routing, ref resolution, caching, Durable Object access, or rate limiting.
- CORS advertises `GET`, `HEAD`, and `OPTIONS`. `OPTIONS` preflight requests return CORS metadata without resolving refs, hitting Durable Objects, rate-limiting as a repo request, or returning route bodies.
- `/bash?cmd=...` runs a read-only shell-shaped pipeline against the repo and always reports the shell exit code in `x-gitvfs-exit-code`.
- `/bash` returns HTTP `200` for exit code `0`, `400` for unknown commands (`127`), `504` for timeouts (`124`), and `422` for other non-zero command exits.

### Rules And Constraints

- Supported `/bash` commands remain read-only: `echo`, `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `find`, `sort`, `uniq`, and `sed`.
- `/bash` non-zero responses preserve stdout/stderr in text mode so shell-like callers can inspect the failure body while also relying on HTTP status.
- `/bash` non-zero responses are not cacheable and must carry `cache-control: no-store`.
- `?lines=` accepts only `N` or `A-B` positive integer syntax. Malformed ranges return `400 bad_lines`; ranges with `end < start` also return `400 bad_lines`.
- Empty files have `0` logical lines.

### Edge Cases

- `Hello World!\n` has exactly one logical line. `?lines=1` returns `Hello World!`; `?lines=2` returns `416 line_range_not_satisfiable`.
- Whole-file numbered output for a trailing-newline file must not append a blank numbered line.
- CORS preflight with custom requested headers echoes those requested headers in `access-control-allow-headers`.
- Unsupported methods receive the same security and CORS headers as other API errors, but no repository metadata because routing never runs.
- A supported command with no matches, such as `grep` returning exit code `1`, is a completed shell command but still maps to HTTP `422`.

### Testing Notes

- Unit-test the outline extractor with trailing-newline and empty-file inputs.
- Integration-test `octocat/Hello-World` through `/file?lines=1`, `/file?lines=2`, `/file?numbered=1`, `/stat`, and `/outline` to prove line-count consistency.
- Integration-test `OPTIONS` with `Origin`, `Access-Control-Request-Method`, and `Access-Control-Request-Headers`; assert status `204`, no body, CORS headers, and no route body.
- Integration-test `POST`, `PUT`, `PATCH`, and `DELETE` against a valid repository route; assert `405 method_not_allowed`, the canonical `Allow` header, matching CORS method metadata, and no `x-gitvfs-sha` route metadata.
- Integration-test `/bash?format=text&cmd=touch%20x` returns `400` with `x-gitvfs-exit-code: 127`.
- Integration-test a no-match `/bash` grep returns `422` with the empty-output footer and `x-gitvfs-exit-code: 1`.

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
