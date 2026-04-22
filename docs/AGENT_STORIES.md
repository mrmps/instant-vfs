# Agent Stories

A ledger of concrete, reproducible failures and frictions an LLM agent hit while
using gitvfs as its only interface to a codebase. Each entry captures **intent →
exact request → actual response → expected response → fix → regression test**,
so that when the same friction resurfaces we can answer "is this new?" in one
grep.

## Why this file exists

Agent feedback comes in as narrative ("I tried X and got nothing back") — lossy,
un-searchable, and easy to dismiss. `test/bugs.test.ts` locks fixes with R-IDs
but doesn't record the *story* behind them: what the agent was doing, what it
thought the command meant, what output actually broke its reasoning loop. This
file is the story layer. Tests are the enforcement layer. They cross-reference.

## Conventions

- **ID format.** `AS-NNN`, monotonically increasing. Never reused.
- **One ID per distinct bad behavior**, even if two symptoms share a root cause.
  Link siblings in the `Related` field.
- **Always paste the raw `curl` and raw response.** Truncate long bodies with
  byte counts; don't paraphrase. Agents grep this file.
- **Every entry ends in a `Test:` pointer.** If no test exists yet, write
  `Test: TODO(AS-NNN)` and add a `test.todo("AS-NNN: ...")` stub in
  `test/bugs.test.ts` the same commit. A story without a test stub rots.
- **Status values:** `open`, `fix-in-progress`, `fixed` (test passes),
  `wontfix` (with reason).
- **When you fix an entry**, flip status to `fixed`, replace `test.todo` with a
  real assertion, and leave the story text intact — the history is the point.

## How this slots into regression tests

`test/bugs.test.ts` owns the executable contract. Every `describe` block in
`bugs.test.ts` gets a `// AS-NNN` leading comment matching its story here.
Grep `AS-` across the repo to pivot between prose and enforcement:

```
rg "AS-0\d\d" docs/ test/
```

New workflow when an agent reports something weird:

1. Reproduce with `curl`, paste transcript here under the next free `AS-NNN`.
2. Add a `test.todo("AS-NNN: ...")` in `bugs.test.ts` the same commit.
3. When fixing, convert `.todo` → real test, flip status to `fixed`.

---

## AS-001 — `?subpath=` silently ignored, returns full tree

- **Status:** fixed (2026-04-21, `src/worker.ts` tree-handler allowlist)
- **Severity:** medium (silent wrong-data; wastes context and misleads the agent)
- **Discovered:** 2026-04-21
- **Test:** `test/bugs.test.ts` → `describe("AS-001: ...")`
- **Related:** R2 family (all "silent" parse failures)

**Agent intent.** Agent wanted to browse only `.opencode/command/` in
`sst/opencode`. It guessed `?subpath=` as the filter param (a reasonable guess
given query-string conventions elsewhere on the service). Path-style
`/tree/.opencode/command` is the correct form.

**Command.**

```
curl -s "https://gitvfs.miryaboy.workers.dev/honojs/hono/tree?subpath=src/middleware"
```

**Actual response.**

```
HTTP/2 200
(477 lines, 14891 bytes — the entire hono repo tree, not filtered)
.devcontainer/Dockerfile
.devcontainer/devcontainer.json
...
```

Reproduced on `sst/opencode` at 198KB. The query param was silently dropped.

**Expected response.** One of:

- `400 bad_param` with `{"error":"unknown_query_param","param":"subpath","hint":"use /tree/<path>"}`, or
- treat `?subpath=` as an alias for the path-style form.

Pick one; either is better than silent-full-tree. 400 is consistent with
R2-family policy ("bad input surfaces, never silently wrong data").

**Fix.** In the `/tree` handler, reject unknown query params with
`400 unknown_query_param` and echo the offending param name plus a hint. The
allowlist is `glob`, `path`, `sizes`, `outlines`, `count`, `depth`, `refresh`.
Any param starting with `_` is passed through (reserved for client-side
cache-busting — matches `test/common.ts` `_cb=` convention). Test-suite cache
busts using unreserved names (`?stable=…`, `?x=…`) were migrated to `_stable=`.

---

## AS-002 — `/tree` has no default page size, easy to context-bomb

- **Status:** fixed (2026-04-21, `src/worker.ts` — `x-gitvfs-entries` on all
  tree responses)
- **Severity:** low-medium (not wrong, just expensive; agents pay in tokens)
- **Discovered:** 2026-04-21
- **Test:** `test/bugs.test.ts` → `describe("AS-002: ...")`

**Agent intent.** Agent called bare `/tree` on an unfamiliar repo to orient
itself. On a mid-size repo (hono) this is 15KB; on `sst/opencode` it was 198KB
— enough to blow a small context window on a single request.

**Command.**

```
curl -s "https://gitvfs.miryaboy.workers.dev/sst/opencode/tree"
```

**Actual response.**

```
HTTP/2 200
(~9000+ paths, 198.4KB plain text; no truncation signal)
```

**Expected response.** Either:

- default `limit=500` with a trailing `x-gitvfs-truncated: true` header and a
  `x-gitvfs-total-entries` header, so the agent can paginate or narrow; or
- no default cap, but emit an `x-gitvfs-entries` header on every `/tree`
  response so the agent can decide after one `HEAD` whether to re-request with
  `?glob=` / `?depth=`.

The existing `/grep` endpoint already signals `truncated` and `count` in JSON.
`/tree` should be consistent.

**Fix.** Every `/tree` and `/tree.json` response now carries
`x-gitvfs-entries: <n>`, where `n` is the number of paths in the response
(text/JSON). Agents can `HEAD /tree` cheaply before deciding to GET, or `HEAD
/tree?glob=**/*.ts` to decide whether it's worth narrowing further. Scope
deliberately stayed small — no separate `returned` header yet; the entries
count IS the body length for non-truncated responses and matches
`entries.length` in JSON.

---

## AS-003 — `?pattern=` on `/grep` returns a 400, but the landing page says "pattern"

- **Status:** fixed (error path is correct; this is a docs-only lock-in)
- **Severity:** low
- **Discovered:** 2026-04-21
- **Test:** `R4` block in `test/bugs.test.ts` (lock current good behavior)

**Agent intent.** Agent read the landing page description of `/grep`
("Search with regex, glob patterns, context…") and tried `?pattern=…`. The
correct param name is `?q=`.

**Command.**

```
curl -s "https://gitvfs.miryaboy.workers.dev/honojs/hono/grep?pattern=useMiddleware"
```

**Actual response.**

```
HTTP/2 400
{
  "error": "missing_q",
  "message": "Missing ?q=<pattern>.",
  "docs": "https://gitvfs.miryaboy.workers.dev/",
  "llms_txt": "https://gitvfs.miryaboy.workers.dev/llms.txt"
}
```

This is *already good* — clear 4xx, useful message, link back to docs. The only
issue is the landing-page prose ("regex", "glob patterns") doesn't name the
param `q`. Agents that don't read `/llms.txt` first will guess wrong once.

**Fix.** None required. The actual landing page and `/llms.txt` already name
`?q=` in every `grep` example; the "pattern" wording was paraphrased by a
summarizing fetcher (`WebFetch`), not from the real docs. `test/bugs.test.ts`
→ `describe("AS-003: ...")` locks the 400 behavior.
