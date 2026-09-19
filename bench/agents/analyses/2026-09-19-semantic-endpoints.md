# Trace analysis — semantic endpoints (`/find`, `/ask`, `?intent=`, `?about=`)

**Runs:** `2026-09-19T08-06-06-939` (minimax-m2.5, 15 tasks × 2 conditions), `2026-09-19T08-09-45-254` (claude-sonnet-4.5 via OpenRouter, same), `2026-09-19T08-15-…` (minimax re-runs of T03, T11–T15 after AS-010/AS-011)
**Worker:** semantic layer live (`src/semantic.ts`, `src/jev.ts`), bench prompt now leads with `/find`
**Tasks:** T01–T10 unchanged; T11–T15 added (questions that need judgment, not a known path)

## Headline

| Metric | Sonnet 4.5 baseline | Sonnet 4.5 + gitvfs | minimax baseline | minimax + gitvfs |
|---|---:|---:|---:|---:|
| Pass rate | 11/15 | **15/15** | 12/15 | **15/15** |
| Mean tool calls | 4.5 | **1.0** | 3.0 | 2.0 |
| Mean input tokens | 135,417 | **4,392** | 22,213 | 2,607 |
| Mean cost / task | $0.416 | **$0.016** | $0.0098 | $0.0018 |
| Mean wall-clock | 20.2s | **5.9s** | 28.4s | 16.9s |

Sonnet solved every task in exactly one call. That is the design goal of `/find`: the hit's snippet, or the auto-inlined `source`, already contains the answer, so the agent never has to read a file.

## What the calls were (classifier.dev over both full runs, 157 calls)

`bun bench/agents/classify-traces.ts <runId>` labels every tool call with classifier.dev in one request:

| Call type | baseline | gitvfs |
|---|---:|---:|
| semantic query | 2 | 12 |
| targeted read | 0 | 14 |
| broad read | 46 | 13 |
| search | 2 | 3 |
| failed request | 34 | 3 |
| github.com / api.github.com | 28 | 0 |
| **total** | 112 | 45 |

A third of baseline calls fail outright (401 on code search, 404 on guessed raw URLs) and another 40% are broad reads (1.3MB recursive trees, 178KB HTML search pages). The gitvfs column is mostly one semantic call plus, for minimax, a defensive targeted read.

## Baseline failure shape (unchanged from April)

T03, T04, T05, T13 with Sonnet: `api.github.com/search/code` → 401, `github.com/…/search` → 178KB HTML, `git/trees?recursive=1` → 1.3MB, then 8 guessed `raw.githubusercontent.com` paths until the 12-call cap. $1–2 per failed task.

## What the first gitvfs run exposed (and what changed)

**T14: `/find?q=useState` → 502.** `LIKE or GLOB pattern too complex` from the Durable Object. Workers' SQLite caps LIKE/GLOB patterns at ~50 bytes; every prefix-scoped query used `path LIKE 'prefix/%'`, so any `/tree/<deep prefix>` on react was already a 500 before this work. Fixed with range comparisons, `instr()` for grep's prefilter, JS evaluation for long globs (AS-010). `/find` also no longer touches the DO for directory levels: it builds them from the path list it already has, so a react-sized repo costs one `tree()` call plus Jev.

**T12: brackets pasted from the docs.** minimax sent `/honojs/hono[@sha]/find`. `bad_path` now returns `suggested` with the brackets removed; `?depth=1&glob=<dir>` returns `suggested: /tree/<dir>?depth=1` (AS-011). Re-run: 7 calls → 1–2.

**"What status code…" ranked http-exception.ts first (0.44).** No code-shaped token to grep, and by name alone `http-exception.ts` sounds more like "status code" than `body-limit/index.ts`. Two additions: paths whose segments contain a question term ("body" → body-limit) join the candidates, and when the top probability is under 0.75 the top three files are read line by line and judged again. Result: `status: 413` at 0.88 with the source inlined.

**T15: hit found, file read anyway.** `/find` returned `BodyLimitError` at line 18 with probability 0.99 and a six-line snippet, and minimax still read the file in three slices. `/find` now inlines the top hit's `source` (≤80 lines) whenever its probability is ≥ 0.8; `read=0` suppresses, `read=1` forces up to 200 lines. Re-run: 4 calls → 1.

## minimax re-runs after the fixes (2 trials each)

| Task | Before | After (trial 1, trial 2) |
|---|---:|---|
| T11 | 2 calls | 1, 1 |
| T12 | 7 calls | 1, 2 |
| T13 | 2 calls | 2, 1 |
| T14 | 4 calls | 3, 1 |
| T15 | 4 calls | 1, 2 |
| T03 | 2 calls | 3, 1 |

## Cost of judgment

Per `/find` on hono (477 files): 4–5 Jev requests, ~5–8k tokens, 700–1300ms of model time, 1.4s end to end cold. On react (6,845 files): 6–9 requests, 15–37k tokens, ~1.0–1.3s of model time. Second identical question: `x-gitvfs-semantic-cache: hit`, zero model calls.

## Open questions

- `exists` is calibrated in the right direction (0.14 for "default max size" in a file with no default; 0.44 for a count question) but has not been measured against a labelled set. A ~50-question set with known "not in this repo" answers would pin the threshold the docs currently give as 0.3.
- Beam search spends most of its requests on directory levels for large repos. A single Choice over the top-2 levels flattened (≤255 entries) might halve it.
