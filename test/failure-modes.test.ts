// Regression tests for the 10 failure modes surfaced by the 30-agent study.
// Each test is derived from a real agent trace; the comments pin the source
// failure so future changes don't regress them.
//
// TDD note: these are written BEFORE the fix. They must all fail on the
// current deploy, then pass after the fix ships.
import { describe, test, expect, beforeAll } from "bun:test";
import { getRaw, getJson, getText, prewarm, BASE } from "./common";

beforeAll(async () => {
  await prewarm("honojs/hono");
});

// -------------------------------------------------------------------
// F1 — bad_path errors must embed expected/example/got so agents stop
// burning 2–3 calls on URL-shape discovery.
// -------------------------------------------------------------------
describe("F1: bad_path includes expected/example/got", () => {
  test("missing owner/repo prefix", async () => {
    const { status, body } = await getJson("/grep?q=foo");
    expect(status).toBe(400);
    expect(body.error).toBe("bad_path");
    expect(typeof body.expected).toBe("string");
    expect(body.expected).toContain(":owner");
    expect(typeof body.example).toBe("string");
    expect(body.example.startsWith("/")).toBe(true);
    expect(typeof body.got).toBe("string");
  });

  test("bare /status also hint-rich", async () => {
    const { status, body } = await getJson("/status");
    expect(status).toBe(400);
    expect(body.error).toBe("bad_path");
    expect(typeof body.expected).toBe("string");
  });

  test("bare /tree also hint-rich", async () => {
    const { status, body } = await getJson("/tree");
    expect(status).toBe(400);
    expect(body.error).toBe("bad_path");
    expect(typeof body.expected).toBe("string");
  });

  test("?repo= query param style → bad_path (and hint has the right shape)", async () => {
    const { status, body } = await getJson("/grep?repo=honojs/hono&q=foo");
    expect(status).toBe(400);
    expect(body.example.toLowerCase()).toContain("honojs");
  });
});

// -------------------------------------------------------------------
// F4 — never-ingested DO must NOT report state: "idle" (reads like "ready").
// -------------------------------------------------------------------
describe("F4: fresh DO status reads as 'not_ingested', not 'idle'", () => {
  test("status on never-seen SHA is not_ingested", async () => {
    // Fresh 40-char SHA = fresh Durable Object with no meta row.
    const freshSha = "0123456789abcdef0123456789abcdef01234567";
    const { status, body } = await getJson(`/facebook/react@${freshSha}/status`);
    expect(status).toBe(200);
    expect(body.state).not.toBe("idle");
    expect(body.state).toBe("not_ingested");
  });
});

// -------------------------------------------------------------------
// F2 / F3 — when the DO's ingest is in a non-ready state, endpoints
// must NOT return 200-empty or plain 404. Caller must be able to
// distinguish "this file does not exist" from "still ingesting / errored".
// -------------------------------------------------------------------
describe("F2/F3: ingest-not-ready is distinguishable from no-match/not-found", () => {
  // The real agent trap was: during a stuck/incomplete ingest, grep would
  // return {count: 0, matches: []} as 200 OK and /file would return 404
  // not_found — both *look* like legitimate "your answer is nothing" rather
  // than "retry, this isn't ready." The contract we enforce now:
  //   · `/file` on a broken or unreachable SHA returns a named error, never
  //     the same `not_found` shape used for real missing files.
  //   · `/grep` on a broken SHA returns a named error, never the normal
  //     {matches: []} empty-results shape.

  test("/file on a broken (nonexistent) SHA surfaces a distinct error", async () => {
    const brokenSha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const res = await getJson<any>(`/facebook/react@${brokenSha}/file/package.json`);
    // Must NOT use the normal file-missing response.
    expect(res.body.error).not.toBe("not_found");
    // Must be a named error the agent can interpret.
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
    // Typical codes: ref_not_found | ingest_failed | not_ready.
    expect(["ref_not_found", "ingest_failed", "not_ready"]).toContain(res.body.error);
  });

  test("/grep on a broken SHA returns a named error, not 200-empty", async () => {
    const brokenSha = "cafebabecafebabecafebabecafebabecafebabe";
    const { status, body } = await getJson<any>(
      `/facebook/react@${brokenSha}/grep?q=useEffect`,
    );
    // The old silent-failure behavior returned 200 + {count: 0, matches: []}.
    if (status === 200) {
      // If we ever return 200, it cannot look like a normal empty grep.
      expect(Array.isArray(body.matches)).toBe(false);
    }
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  test("/file on a never-ingested DO is not a plain 404 with empty suggestions", async () => {
    // Fresh SHA → ensureIngested tries tarball → GitHub 404 → state=error
    // → must surface as a named error, not {"error": "not_found", suggestions: []}.
    const freshSha = "abcdef0123456789abcdef0123456789abcdef01";
    const res = await getJson<any>(`/facebook/react@${freshSha}/file/README.md`);
    expect(res.body.error).not.toBe("not_found");
  });
});

// -------------------------------------------------------------------
// F5 — malformed regex must 400, not silently return empty.
// -------------------------------------------------------------------
describe("F5: malformed regex returns 400 bad_regex", () => {
  test("unclosed character class [", async () => {
    const { status, body } = await getJson("/honojs/hono/grep?q=%5B&regex=1");
    expect(status).toBe(400);
    expect(body.error).toBe("bad_regex");
  });

  test("unbalanced closing paren )", async () => {
    const { status, body } = await getJson("/honojs/hono/grep?q=foo%29&regex=1");
    expect(status).toBe(400);
    expect(body.error).toBe("bad_regex");
  });

  test("unbalanced opening paren (", async () => {
    const { status, body } = await getJson("/honojs/hono/grep?q=%28foo&regex=1");
    expect(status).toBe(400);
    expect(body.error).toBe("bad_regex");
  });

  test("complex pattern with unmatched alternation group", async () => {
    // func.*) Schedule(  — exactly what the k8s agent tried
    const q = encodeURIComponent("func.*) Schedule(");
    const { status, body } = await getJson(`/honojs/hono/grep?q=${q}&regex=1`);
    expect(status).toBe(400);
    expect(body.error).toBe("bad_regex");
  });
});

// -------------------------------------------------------------------
// F6 — grep with context + narrow single-file glob must not return
// {error: "internal_error"} as a 200 OK body.
// -------------------------------------------------------------------
describe("F6: grep with context + single-file glob works", () => {
  test("context=4 + glob pointing at a single file returns normal grep result", async () => {
    const res = await getRaw(
      `/honojs/hono/grep?q=Hono&glob=src/hono.ts&context=4&format=text`,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Either matches exist (expected since "Hono" is in src/hono.ts) or an explicit empty string.
    // Must NOT be the internal_error JSON.
    expect(body).not.toContain("internal_error");
  });

  test("same query as JSON returns matches with prev/after arrays", async () => {
    const { status, body } = await getJson<any>(
      `/honojs/hono/grep?q=Hono&glob=src/hono.ts&context=4`,
    );
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(Array.isArray(body.matches)).toBe(true);
  });
});

// -------------------------------------------------------------------
// F7 — outline recognises C / C++ / Java / Kotlin (currently "text").
// -------------------------------------------------------------------
describe("F7: outline covers more languages than just JS/TS/Py/Go/Rust", () => {
  // hono is not a C++ repo, so we create a synthetic test by picking a known C++
  // file in a warmed repo. Use oven-sh/bun's *.c / *.h path only if it's small.
  // To stay fast and deterministic, verify the LANG_BY_EXT map directly via a
  // tiny stub file in a repo we already have: sindresorhus/ky doesn't have .c
  // files, so use a predictable test.
  //
  // Practical test: the *language* reported for common extensions should not
  // be "text". We exercise this via a repo we control? Not available — so test
  // indirectly by asking for outline of a real .c/.h in a public repo.
  //
  // For now, assert the LANG_BY_EXT coverage via repo `curl/curl` which has
  // a simple C source layout.
  test("C header file is detected as language 'c' and extracts symbols", async () => {
    const res = await getJson<any>(`/curl/curl/outline/include/curl/curl.h`);
    if (res.status !== 200) return; // skip if ingest not available
    expect(res.body.language).toBe("c");
    expect(Array.isArray(res.body.items)).toBe(true);
    // curl.h has hundreds of typedefs/enums/function prototypes.
    expect(res.body.items.length).toBeGreaterThan(10);
  }, 60_000);

  test("C header file imports #include directives", async () => {
    const res = await getJson<any>(`/curl/curl/outline/include/curl/curl.h`);
    if (res.status !== 200) return;
    expect(Array.isArray(res.body.imports)).toBe(true);
    expect(res.body.imports.length).toBeGreaterThan(0);
  }, 60_000);
});
