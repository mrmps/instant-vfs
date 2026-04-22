// Agent stories — canonical multi-step workflows an LLM agent should be able to do,
// using gitvfs as its ONLY interface to the code. Each story simulates a real task
// and asserts that the information the agent needs is actually reachable in a
// reasonable number of round-trips.
//
// Guiding principle: an agent should get to an answer in ≤ 6 calls for any story.
//
// Runs against deployed URL. Uses bun:test.
import { describe, test, expect, beforeAll } from "bun:test";
import { getRaw, getJson, getText, prewarm, approxTokens } from "./common";

const HONO = "honojs/hono";
const REACT = "facebook/react";

beforeAll(async () => {
  await Promise.all([prewarm(HONO), prewarm(REACT)]);
});

// -------------------------------------------------------------------
// Story 1: "What is this repo?"  — agent is handed a URL, wants a 30-sec overview.
// -------------------------------------------------------------------
describe("Story 1: understand a new repo", () => {
  test("can get: tree count, top-level layout, README outline in ≤3 calls", async () => {
    // Call 1: count + top-level tree shape
    const countRes = await getText(`/${HONO}/tree?count=1`);
    expect(countRes.status).toBe(200);
    const fileCount = Number(countRes.body.trim());
    expect(fileCount).toBeGreaterThan(10);

    // Call 2: top-level directories only
    const topRes = await getText(`/${HONO}/tree?glob=*`);
    expect(topRes.status).toBe(200);
    const topEntries = topRes.body.trim().split("\n");
    expect(topEntries.length).toBeGreaterThan(3);
    // Should include typical top-level files
    const topText = topRes.body;
    expect(topText).toContain("package.json");

    // Call 3: README outline (not full content)
    const { status, body: readme } = await getJson<any>(`/${HONO}/outline/README.md`);
    // README is markdown — outline will have few items but should succeed with imports:[] items:[]
    expect([200, 404]).toContain(status);
  });
});

// -------------------------------------------------------------------
// Story 2: "Find where useState is defined."  — classic find-definition.
// -------------------------------------------------------------------
describe("Story 2: find where a symbol is defined", () => {
  test("grep with word-boundary + files_only + filter → narrow set", async () => {
    // Call 1: get candidate files that export useState
    const { body } = await getJson<any>(
      `/${REACT}/grep?q=export+function+useState&files_only=1&glob=packages/**/*.js&limit=20`,
    );
    expect(body.files.length).toBeGreaterThan(0);
    // Must include the canonical location.
    expect(body.files).toContain("packages/react/src/ReactHooks.js");
  });

  test("then outline + read the relevant lines", async () => {
    const o = await getJson<any>(
      `/${REACT}/outline/packages/react/src/ReactHooks.js`,
    );
    expect(o.status).toBe(200);
    const useState = o.body.items.find((it: any) => it.name === "useState");
    expect(useState).toBeTruthy();
    expect(useState.line).toBeGreaterThan(0);

    // Read just a few lines around it, not the whole file.
    const start = useState.line;
    const end = start + 10;
    const file = await getText(
      `/${REACT}/file/packages/react/src/ReactHooks.js?lines=${start}-${end}`,
    );
    expect(file.status).toBe(200);
    expect(file.body).toContain("useState");
    expect(approxTokens(file.body)).toBeLessThan(500);
  });
});

// -------------------------------------------------------------------
// Story 3: "Read a file but only the interesting lines."
// -------------------------------------------------------------------
describe("Story 3: surgical file read (outline → line range)", () => {
  test("outline tells agent where symbols live; ?lines= fetches only those", async () => {
    const o = await getJson<any>(`/${HONO}/outline/src/hono.ts`);
    expect(o.status).toBe(200);
    // Pick any item with a line number.
    const item = o.body.items[0];
    expect(item).toBeTruthy();
    const start = item.line;
    const end = item.line + 5;
    const f = await getText(
      `/${HONO}/file/src/hono.ts?lines=${start}-${end}`,
    );
    expect(f.status).toBe(200);
    // total-lines header helps agent know bounds.
    expect(f.headers.get("x-gitvfs-total-lines")).not.toBeNull();
    expect(f.headers.get("x-gitvfs-line-range")).toBe(`${start}-${end}`);
  });
});

// -------------------------------------------------------------------
// Story 4: "Survey middleware patterns in hono."
// -------------------------------------------------------------------
describe("Story 4: survey a feature area in the repo", () => {
  test("tree prefix + outline of a peer gives structure in ≤3 calls", async () => {
    // Call 1: list subtree
    const tree = await getText(`/${HONO}/tree/src/middleware?sizes=1`);
    expect(tree.status).toBe(200);
    const lines = tree.body.trim().split("\n");
    expect(lines.length).toBeGreaterThan(5);

    // Call 2: outline one existing peer (body-limit) to see structure
    const o = await getJson<any>(`/${HONO}/outline/src/middleware/body-limit/index.ts`);
    expect(o.status).toBe(200);
    expect(o.body.items.length).toBeGreaterThan(0);

    // Call 3: find registration refs for the peer basename
    const reg = await getJson<any>(
      `/${HONO}/grep?q=body-limit&files_only=1&limit=30`,
    );
    expect(reg.status).toBe(200);
    // Should find at least the package.json or jsr export file.
    expect(reg.body.files.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------
// Story 5: "Trace a call from public API down to implementation."
// -------------------------------------------------------------------
describe("Story 5: trace a call path via grep + outline", () => {
  test("public symbol → internal symbol → implementation in few calls", async () => {
    // Public export
    const step1 = await getJson<any>(
      `/${REACT}/grep?q=export+function+useReducer&files_only=1&glob=packages/**/*.js&limit=5`,
    );
    expect(step1.body.files.length).toBeGreaterThan(0);

    // Find mountReducer / updateReducer internals
    const step2 = await getJson<any>(
      `/${REACT}/grep?q=function+updateReducer&files_only=1&glob=packages/react-reconciler/**/*.js&limit=5`,
    );
    expect(step2.body.files.length).toBeGreaterThan(0);
    expect(step2.body.files[0]).toContain("ReactFiberHooks");
  });
});

// -------------------------------------------------------------------
// Story 6: "Check if repo has TypeScript."  — count, not listing.
// -------------------------------------------------------------------
describe("Story 6: answer yes/no without pulling the content", () => {
  test("tree?glob=**/*.ts&count=1 gives a number only", async () => {
    const { status, body } = await getText(
      `/${REACT}/tree?glob=**/*.ts&count=1`,
    );
    expect(status).toBe(200);
    const n = Number(body.trim());
    expect(n).toBeGreaterThan(0);
    // Body is a single short number — token-efficient.
    expect(body.length).toBeLessThan(20);
  });
});

// -------------------------------------------------------------------
// Story 7: "Test-file-free grep."  — agent avoiding test noise.
// -------------------------------------------------------------------
describe("Story 7: grep while excluding tests and docs", () => {
  test("exclude_glob repeatable filters both", async () => {
    const { status, body } = await getJson<any>(
      `/${HONO}/grep?q=middleware&files_only=1&limit=50` +
        `&exclude_glob=**/*.test.ts&exclude_glob=**/*.md&exclude_glob=docs/**`,
    );
    expect(status).toBe(200);
    for (const p of body.files) {
      expect(p).not.toMatch(/\.test\.ts$/);
      expect(p).not.toMatch(/\.md$/);
      expect(p).not.toMatch(/^docs\//);
    }
  });
});

// -------------------------------------------------------------------
// Story 8: "Reproducible / pinned reads."  — agent wants a stable snapshot.
// -------------------------------------------------------------------
describe("Story 8: pin to SHA for reproducible reads", () => {
  test("resolve ref → pin SHA → immutable cache", async () => {
    // 1. Resolve current default branch to SHA.
    const statusRes = await getJson<any>(`/${HONO}/status`);
    const sha = statusRes.body.sha;
    expect(sha.length).toBe(40);

    // 2. Request via SHA. Cache should say immutable.
    const res = await getRaw(`/${HONO}@${sha}/tree?count=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-gitvfs-ref-resolved")).toBe("direct");
  });

  test("x-gitvfs-pin-hint gives the SHA URL on mutable refs", async () => {
    const res = await getRaw(`/${HONO}/tree?count=1`);
    const hint = res.headers.get("x-gitvfs-pin-hint");
    expect(hint).not.toBeNull();
    expect(hint!).toMatch(new RegExp(`^/${HONO}@[0-9a-f]{40}/`));
  });
});

// -------------------------------------------------------------------
// Story 9: "Cheap existence probe."  — want to know if a file is there.
// -------------------------------------------------------------------
describe("Story 9: existence check without pulling content", () => {
  test("HEAD /file or /stat answers cheaply", async () => {
    // HEAD
    const headRes = await fetch(
      `${process.env.GITVFS_BASE ?? "https://gitvfs.miryaboy.workers.dev"}/${HONO}/file/src/hono.ts`,
      { method: "HEAD" },
    );
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("content-length")).not.toBeNull();

    // stat
    const st = await getJson<any>(`/${HONO}/stat/src/hono.ts`);
    expect(st.status).toBe(200);
    expect(st.body.size).toBeGreaterThan(0);
    expect(st.body.mime).toBeTruthy();
  });
});

// -------------------------------------------------------------------
// Story 10: "Safe failure modes."  — on a bad query, agent should see
// a clear 4xx error code and not silently get wrong data.
// -------------------------------------------------------------------
describe("Story 10: failures are visible and actionable", () => {
  test("every bad input returns 400/404 with {error} JSON", async () => {
    const cases = [
      { url: `/${HONO}/grep?q=foo&glob=`, expect: 400 },
      { url: `/${HONO}/grep?regex=1&q=%5B`, expect: 400 },
      { url: `/${HONO}/file/src/hono.ts?lines=abc`, expect: 400 },
      { url: `/${HONO}/grep?q=x&limit=abc`, expect: 400 },
      { url: `/${HONO}/grep`, expect: 400 },
      { url: `/${HONO}/file/nope/nope.ts`, expect: 404 },
      { url: `/${HONO}@nonexistent-12345/tree`, expect: 404 },
      { url: `/zzznoexist-user-xyz/zzz-repo/tree`, expect: 404 },
    ];
    for (const c of cases) {
      const r = await getJson<any>(c.url);
      expect(r.status, `URL ${c.url}`).toBe(c.expect);
      expect(r.body.error, `URL ${c.url}`).toBeTruthy();
    }
  });
});

// -------------------------------------------------------------------
// Story 11: "Warm reads stay under 500ms."  — perf budget for agent loops.
// -------------------------------------------------------------------
describe("Story 11: warm-read performance budget", () => {
  test("5 sequential warm tree reads all under 1000ms", async () => {
    const durations: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = await getRaw(`/${HONO}/tree`); // getRaw appends _cb= to bypass edge cache
      expect(r.status).toBe(200);
      await r.text();
      durations.push(performance.now() - t0);
    }
    const p50 = durations.slice().sort()[Math.floor(durations.length / 2)];
    // From typical client → CF edge, this is ~300-500ms DO latency.
    expect(p50).toBeLessThan(1000);
  });

  test("edge-cached warm reads stay under 500ms", async () => {
    // Hit same URL (bust: false) so the edge cache can actually hit.
    // _stable is reserved (underscore-prefixed) so the allowlist accepts it.
    const url = `/${HONO}/tree?_stable=${Date.now()}`;
    await getRaw(url, {}, { bust: false }); // prime
    await new Promise((r) => setTimeout(r, 1000)); // let waitUntil finish cache.put
    const durations: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = await getRaw(url, {}, { bust: false });
      await r.text();
      durations.push(performance.now() - t0);
    }
    const p50 = durations.slice().sort()[Math.floor(durations.length / 2)];
    // Budget is generous — real median is 60–120ms from good links, up to ~300ms on slow ones.
    expect(p50).toBeLessThan(500);
  });
});
