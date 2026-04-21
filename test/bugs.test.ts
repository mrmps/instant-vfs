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
