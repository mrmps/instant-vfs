// Regression tests for every issue reported by the evaluation agents.
// Runs against a deployed gitvfs URL (default: https://gitvfs.miryaboy.workers.dev).
import { describe, test, expect, beforeAll } from "bun:test";
import { getRaw, getJson, getText, head, prewarm } from "./common";

// Use a small, stable public repo for fast warm tests.
const TEST_REPO = "honojs/hono";

beforeAll(async () => {
  await prewarm(TEST_REPO);
});

describe("R1 bug: grep silently capped at 1000", () => {
  test("limit=10000 is honored (or higher than old 1000 cap)", async () => {
    // Popular token — expect many hits.
    const { body } = await getJson(`/${TEST_REPO}/grep?q=import&limit=10000`);
    expect(body.count).toBeGreaterThan(100);
    expect(typeof body.truncated).toBe("boolean");
    expect(typeof body.filesScanned).toBe("number");
  });

  test("response explicitly signals truncation when hit", async () => {
    // Ask for 5; a popular token will definitely exceed.
    const { body } = await getJson(`/${TEST_REPO}/grep?q=import&limit=5`);
    expect(body.truncated).toBe(true);
    expect(body.count).toBe(5);
  });
});

describe("R2 bug 1: long path → 500", () => {
  test("path with 100+ segments → 400 bad_path, not 500", async () => {
    const longPath = Array(100).fill("a").join("/") + "/x.js";
    const { status, body } = await getJson(`/${TEST_REPO}/file/${longPath}`);
    expect(status).toBe(400);
    expect(body.error).toBe("bad_path");
  });
});

describe("R2 bug 2: malformed regex silently returns 0", () => {
  test("bad regex returns 400 bad_regex, not 200 empty", async () => {
    const { status, body } = await getJson(`/${TEST_REPO}/grep?regex=1&q=%5B`);
    expect(status).toBe(400);
    expect(body.error).toBe("bad_regex");
  });
});

describe("R2 bug 3: empty glob silently returns empty", () => {
  test("empty glob returns 400", async () => {
    const { status, body } = await getJson(`/${TEST_REPO}/grep?q=foo&glob=`);
    expect(status).toBe(400);
    expect(body.error).toBe("bad_glob");
  });
});

describe("R2 bug 4: bad ?lines= silently returns full file", () => {
  test("lines=abc returns 400 bad_lines", async () => {
    const { status, body } = await getJson(`/${TEST_REPO}/file/src/hono.ts?lines=abc`);
    expect(status).toBe(400);
    expect(body.error).toBe("bad_lines");
  });
  test("lines=50-10 (end<start) returns 400", async () => {
    const { status, body } = await getJson(`/${TEST_REPO}/file/src/hono.ts?lines=50-10`);
    expect(status).toBe(400);
    expect(body.error).toBe("bad_lines");
  });
});

describe("R2 bug 5: short SHA cached as immutable", () => {
  test("short SHA URL responds with x-gitvfs-ref-resolved=github (not direct)", async () => {
    // Use a 7-char prefix of a known SHA of hono.
    const { body: status } = await getJson(`/${TEST_REPO}/status`);
    const fullSha = status.sha;
    const shortSha = fullSha.slice(0, 7);
    const res = await getRaw(`/${TEST_REPO}@${shortSha}/tree?count=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gitvfs-ref-resolved")).toBe("github");
    // Short SHAs must NOT get the immutable cache-control that full SHAs get.
    expect(res.headers.get("cache-control")).not.toContain("immutable");
    // Full SHA should be in x-gitvfs-sha (not the short one echoed).
    expect(res.headers.get("x-gitvfs-sha")).toBe(fullSha);
  });
  test("full 40-char SHA gets immutable cache", async () => {
    const { body: status } = await getJson(`/${TEST_REPO}/status`);
    const fullSha = status.sha;
    const res = await getRaw(`/${TEST_REPO}@${fullSha}/tree?count=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-gitvfs-ref-resolved")).toBe("direct");
  });
});

describe("R2 bug 7: tag-like refs miss immutable-ish caching", () => {
  test("semver tag gets long cache (>= 1 day)", async () => {
    const res = await getRaw(`/${TEST_REPO}@v4.0.0/tree?count=1`);
    // Tag may not exist; if it does, cache-control should be 86400 or more.
    if (res.status === 200) {
      const cc = res.headers.get("cache-control") ?? "";
      const m = cc.match(/max-age=(\d+)/);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThanOrEqual(86400);
    }
  });
});

describe("R3 bug: grep exclude_glob", () => {
  test("exclude_glob actually drops files", async () => {
    const without = await getJson<any>(
      `/${TEST_REPO}/grep?q=middleware&files_only=1&limit=1000`,
    );
    const withExclude = await getJson<any>(
      `/${TEST_REPO}/grep?q=middleware&files_only=1&limit=1000&exclude_glob=**/*.test.ts`,
    );
    expect(without.body.count).toBeGreaterThanOrEqual(withExclude.body.count);
    // Every file in the filtered result must not match the exclude glob.
    for (const p of withExclude.body.files) {
      expect(p.endsWith(".test.ts")).toBe(false);
    }
  });
  test("multiple exclude_glob are combined", async () => {
    const { body } = await getJson<any>(
      `/${TEST_REPO}/grep?q=.&regex=1&files_only=1&limit=1000` +
        `&exclude_glob=**/*.test.ts&exclude_glob=**/*.md`,
    );
    for (const p of body.files) {
      expect(p.endsWith(".test.ts")).toBe(false);
      expect(p.endsWith(".md")).toBe(false);
    }
  });
});

describe("R1 wish: grep files_only=1", () => {
  test("returns unique paths, no matches field", async () => {
    const { body } = await getJson<any>(
      `/${TEST_REPO}/grep?q=import&files_only=1&limit=20`,
    );
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files.length).toBeGreaterThan(0);
    // Dedup
    expect(new Set(body.files).size).toBe(body.files.length);
  });
});

describe("R1 wish: word boundary", () => {
  test("word=1 doesn't match substrings", async () => {
    // Looking for "set" as a whole word should NOT match "setHeader" etc.
    const { body } = await getJson<any>(
      `/${TEST_REPO}/grep?q=set&word=1&glob=src/**/*.ts&limit=50&format=json`,
    );
    for (const m of body.matches) {
      expect(/\bset\b/.test(m.text)).toBe(true);
    }
  });
});

describe("R1 wish: tree?count=1", () => {
  test("returns just a number as text", async () => {
    const { status, body } = await getText(`/${TEST_REPO}/tree?count=1`);
    expect(status).toBe(200);
    expect(body.trim()).toMatch(/^\d+$/);
    expect(Number(body.trim())).toBeGreaterThan(10);
  });
  test("count with glob", async () => {
    const { body } = await getText(`/${TEST_REPO}/tree?glob=src/**&count=1`);
    const n = Number(body.trim());
    expect(n).toBeGreaterThan(0);
  });
});

describe("R3 wish: /outline/<path>", () => {
  test("returns parsed imports + items + line counts", async () => {
    const { status, body } = await getJson<any>(
      `/${TEST_REPO}/outline/src/hono.ts`,
    );
    expect(status).toBe(200);
    expect(body.language).toBe("typescript");
    expect(Array.isArray(body.items)).toBe(true);
    expect(Array.isArray(body.imports)).toBe(true);
    expect(body.totalLines).toBeGreaterThan(0);
  });
  test("outline of a non-existent file returns 404 with suggestions", async () => {
    const { status, body } = await getJson<any>(
      `/${TEST_REPO}/outline/src/hon.ts`,
    );
    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
    expect(Array.isArray(body.suggestions)).toBe(true);
  });
});

describe("HEAD on /file returns metadata without body", () => {
  test("HEAD returns 200 + content-length, empty body", async () => {
    const res = await head(`/${TEST_REPO}/file/src/hono.ts`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).not.toBeNull();
    const body = await res.text();
    expect(body.length).toBe(0);
  });
  test("HEAD on missing file returns 404, no body", async () => {
    const res = await head(`/${TEST_REPO}/file/does/not/exist.ts`);
    expect(res.status).toBe(404);
  });
});

describe("invalid limit on grep", () => {
  test("grep?limit=notanumber → 400", async () => {
    const { status, body } = await getJson(`/${TEST_REPO}/grep?q=foo&limit=abc`);
    expect(status).toBe(400);
    expect(body.error).toBe("bad_limit");
  });
});

describe("missing q on grep", () => {
  test("grep with no q → 400 missing_q", async () => {
    const { status, body } = await getJson(`/${TEST_REPO}/grep`);
    expect(status).toBe(400);
    expect(body.error).toBe("missing_q");
  });
  test("grep with q='' → 400", async () => {
    const { status, body } = await getJson(`/${TEST_REPO}/grep?q=`);
    expect(status).toBe(400);
  });
});

// AS-001 — see docs/AGENT_STORIES.md
describe("AS-001: /tree?subpath= must not silently return full tree", () => {
  test("unknown query params on /tree return 400", async () => {
    const { status, body } = await getJson(
      `/${TEST_REPO}/tree?subpath=src/middleware`,
    );
    expect(status).toBe(400);
    expect(body.error).toBe("unknown_query_param");
    expect(body.param).toBe("subpath");
  });
  test("cache-bust params prefixed with _ are allowed", async () => {
    const res = await getRaw(`/${TEST_REPO}/tree?_cb=abc123`);
    expect(res.status).toBe(200);
  });
});

// AS-002 — see docs/AGENT_STORIES.md
describe("AS-002: /tree surfaces entry count for pagination", () => {
  test("/tree response carries x-gitvfs-entries header", async () => {
    const res = await getRaw(`/${TEST_REPO}/tree`);
    expect(res.status).toBe(200);
    const entries = res.headers.get("x-gitvfs-entries");
    expect(entries).not.toBeNull();
    expect(Number(entries)).toBeGreaterThan(0);
  });
  test("entry count matches body line count on text response", async () => {
    const res = await getRaw(`/${TEST_REPO}/tree`);
    const body = await res.text();
    const bodyLines = body.trim().split("\n").length;
    const entries = Number(res.headers.get("x-gitvfs-entries"));
    expect(entries).toBe(bodyLines);
  });
});

// AS-003 — see docs/AGENT_STORIES.md. Locks current good behavior.
describe("AS-003: /grep?pattern= returns 400 missing_q, not silent success", () => {
  test("pattern= (common wrong guess) 400s with missing_q", async () => {
    const { status, body } = await getJson(
      `/${TEST_REPO}/grep?pattern=useMiddleware`,
    );
    expect(status).toBe(400);
    expect(body.error).toBe("missing_q");
  });
});

// AS-004 — /file?lines=A-B&numbered=1 prepends line numbers in the body.
// Source: discovery-bench trace analysis, T06 (useState line lookup).
// Baseline triangulated with 4 slicing calls because slices had no line numbers.
describe("AS-004: /file?lines=A-B&numbered=1 prepends line numbers", () => {
  test("numbered=1 prepends ` N | ` to each line in the slice", async () => {
    const res = await getRaw(`/${TEST_REPO}/file/src/hono.ts?lines=10-13&numbered=1`);
    expect(res.status).toBe(200);
    const body = await res.text();
    const lines = body.split("\n");
    // Each line should start with a zero-padded number, pipe, space.
    expect(lines[0]).toMatch(/^\s*10 \| /);
    expect(lines[1]).toMatch(/^\s*11 \| /);
    expect(lines[2]).toMatch(/^\s*12 \| /);
    expect(lines[3]).toMatch(/^\s*13 \| /);
  });
  test("numbered=0 (default) returns raw content unchanged", async () => {
    const res = await getRaw(`/${TEST_REPO}/file/src/hono.ts?lines=10-13`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // No line-number prefix.
    expect(body.split("\n")[0]).not.toMatch(/^\s*\d+ \| /);
  });
  test("numbered=1 works without ?lines= (whole file)", async () => {
    const res = await getRaw(`/${TEST_REPO}/file/src/hono.ts?numbered=1`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.split("\n")[0]).toMatch(/^\s*1 \| /);
  });
});

// AS-005 — grep?symbols=1 annotates each match with enclosing symbol name.
// Source: discovery-bench trace, T06. Agent had to do outline follow-up to
// know what function a grep hit was inside.
describe("AS-005: grep?symbols=1 annotates matches with enclosing symbol", () => {
  test("?symbols=1 adds inSymbol field to each match", async () => {
    // Grep for something that lives inside a named export in src/hono.ts.
    const { status, body } = await getJson<any>(
      `/${TEST_REPO}/grep?q=extends+HonoBase&symbols=1&limit=5`,
    );
    expect(status).toBe(200);
    expect(body.matches.length).toBeGreaterThan(0);
    // The `extends HonoBase` line is inside the exported class `Hono`.
    const m = body.matches.find((x: any) => x.path === "src/hono.ts");
    expect(m).toBeTruthy();
    expect(m.inSymbol).toBe("Hono");
  });
  test("no ?symbols=1 → no inSymbol field (backward compatible)", async () => {
    const { body } = await getJson<any>(
      `/${TEST_REPO}/grep?q=extends+HonoBase&limit=5`,
    );
    for (const m of body.matches) {
      expect(m.inSymbol).toBeUndefined();
    }
  });
});

// AS-006 — grep response adds matchedFiles (clearer than ambiguous filesScanned).
// Source: discovery-bench trace analysis — filesScanned is consistently misread
// by agents and humans as "files searched" rather than "files with matches."
describe("AS-006: grep response carries matchedFiles count", () => {
  test("matchedFiles is the count of distinct paths with >= 1 match", async () => {
    const { body } = await getJson<any>(
      `/${TEST_REPO}/grep?q=middleware&limit=1000`,
    );
    expect(typeof body.matchedFiles).toBe("number");
    const distinctPaths = new Set(body.matches.map((m: any) => m.path)).size;
    expect(body.matchedFiles).toBe(distinctPaths);
  });
  test("files_only mode: matchedFiles equals files.length", async () => {
    const { body } = await getJson<any>(
      `/${TEST_REPO}/grep?q=middleware&files_only=1&limit=1000`,
    );
    expect(body.matchedFiles).toBe(body.files.length);
  });
  test("filesScanned is still present for backward compatibility", async () => {
    const { body } = await getJson<any>(
      `/${TEST_REPO}/grep?q=middleware&limit=10`,
    );
    expect(typeof body.filesScanned).toBe("number");
  });
});

// AS-007 — /llms.txt recommends /outline before /file?lines= for symbol lookups.
// Source: discovery-bench trace, T06. Agent went to /file?lines= first; /outline
// would have given the answer in one call.
describe("AS-007: /llms.txt guides agents to /outline for symbol-location", () => {
  test("/llms.txt lists /outline before /file in the endpoint section", async () => {
    const res = await getRaw(`/llms.txt`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // Find the "## Endpoints" section and check the order.
    const endpointsBlock = body.split("## Endpoints")[1]?.split("##")[0] ?? "";
    const outlineIdx = endpointsBlock.indexOf("/outline");
    const fileSliceIdx = endpointsBlock.indexOf("/file/");
    expect(outlineIdx).toBeGreaterThan(-1);
    expect(fileSliceIdx).toBeGreaterThan(-1);
    expect(outlineIdx).toBeLessThan(fileSliceIdx);
  });
  test("/llms.txt explicitly names /outline as the answer for line-of-symbol questions", async () => {
    const res = await getRaw(`/llms.txt`);
    const body = await res.text();
    // A single sentence that any agent can find with a regex.
    expect(body).toMatch(/line.*symbol|symbol.*line|where is .*defined/i);
    expect(body).toMatch(/\/outline/);
  });
});

// AS-008 — /symbol/<path>?name=X collapses "where is foo defined" to 1 call.
// Source: discovery-bench trace, T06.
describe("AS-008: /symbol/<path>?name=X returns one symbol", () => {
  const REACT_SHA = "7aa5dda3b3e4c2baa905a59b922ae7ec14734b24";
  test("returns {name, line, endLine, kind} for a matching symbol", async () => {
    const { status, body } = await getJson<any>(
      `/facebook/react@${REACT_SHA}/symbol/packages/react/src/ReactHooks.js?name=useState`,
    );
    expect(status).toBe(200);
    expect(body.name).toBe("useState");
    expect(body.line).toBe(93);
    expect(body.kind).toBeTruthy();
    expect(body.endLine).toBeGreaterThan(body.line);
  });
  test("missing ?name= returns 400", async () => {
    const { status, body } = await getJson<any>(
      `/facebook/react@${REACT_SHA}/symbol/packages/react/src/ReactHooks.js`,
    );
    expect(status).toBe(400);
    expect(body.error).toBe("missing_name");
  });
  test("unknown name returns 404 with suggestions", async () => {
    const { status, body } = await getJson<any>(
      `/facebook/react@${REACT_SHA}/symbol/packages/react/src/ReactHooks.js?name=useDefinitelyNotReal`,
    );
    expect(status).toBe(404);
    expect(body.error).toBe("symbol_not_found");
    expect(Array.isArray(body.suggestions)).toBe(true);
  });
  test("unknown file returns 404 like /outline does", async () => {
    const { status, body } = await getJson<any>(
      `/facebook/react@${REACT_SHA}/symbol/does/not/exist.js?name=foo`,
    );
    expect(status).toBe(404);
    expect(body.error).toBe("not_found");
  });
});

// AS-009 — unexpanded shell variable in ref returns 400 with a copy-paste hint.
// Source: in-session repro — URL `.../repo@$PI/tree` sent literally because the
// `$PI` wasn't set in the browser/tool that received the URL. GitHub 422's it;
// we were returning a generic `ref_not_found` 404 that didn't explain the cause.
describe("AS-009: unexpanded shell variable in ref returns helpful 400", () => {
  test("ref starting with $ returns 400 unexpanded_shell_variable", async () => {
    const { status, body } = await getJson(`/${TEST_REPO}@$PI/tree`);
    expect(status).toBe(400);
    expect(body.error).toBe("unexpanded_shell_variable");
    expect(body.ref).toBe("$PI");
    // The message should name the offending ref and tell them what to do.
    expect(String(body.message)).toMatch(/shell variable|unexpanded/i);
    expect(String(body.hint)).toMatch(/omit @|literal SHA|set the variable/i);
  });
  test("ref with ${...} form also caught", async () => {
    const { status, body } = await getJson(`/${TEST_REPO}@\${PI}/tree`);
    expect(status).toBe(400);
    expect(body.error).toBe("unexpanded_shell_variable");
  });
  test("ref with $ in the middle (still clearly shell) also caught", async () => {
    const { status, body } = await getJson(`/${TEST_REPO}@v1-$BRANCH/tree`);
    expect(status).toBe(400);
    expect(body.error).toBe("unexpanded_shell_variable");
  });
  test("legit refs with no $ are unaffected", async () => {
    const res = await getRaw(`/${TEST_REPO}@main/tree?count=1`);
    // main or head should resolve fine.
    expect([200, 404]).toContain(res.status);
    if (res.status === 400) {
      // If it 400s it must not be for shell-var reasons.
      const body = await res.json() as any;
      expect(body.error).not.toBe("unexpanded_shell_variable");
    }
  });
});

describe("ref_not_found is 404, not 500", () => {
  test("nonexistent ref returns 404", async () => {
    const { status, body } = await getJson(
      `/${TEST_REPO}@this-branch-does-not-exist-1234/tree`,
    );
    expect(status).toBe(404);
    expect(body.error).toBe("ref_not_found");
  });
  test("nonexistent repo returns 404", async () => {
    const { status, body } = await getJson(`/no-such-user-xyz/no-such-repo-xyz/tree`);
    expect(status).toBe(404);
    expect(body.error).toBe("ref_not_found");
  });
});
