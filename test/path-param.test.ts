// Regression tests for the "bash-style path=" friction surfaced by the
// 30-agent study. Agents repeatedly wrote `/tree?path=src`, `/grep?path=file.ts`,
// `/outline?path=X` expecting `path` to work like a positional operand in
// `grep pat path/`, `find path/`, `ls path/`, `tree path/`. We now accept it.
//
// Contract:
//   /tree?path=<dir>      = /tree/<dir>  (subtree listing)
//   /grep?path=<prefix>   = scope scan to anything under <prefix>
//   /outline?path=<file>  = /outline/<file>
import { describe, test, expect, beforeAll } from "bun:test";
import { getRaw, getJson, getText, prewarm } from "./common";

const REPO = "honojs/hono";

beforeAll(async () => {
  await prewarm(REPO);
});

describe("/tree?path= scopes to subdirectory", () => {
  test("/tree?path=src returns same body as /tree/src", async () => {
    const viaQuery = await getText(`/${REPO}/tree?path=src`);
    const viaSegment = await getText(`/${REPO}/tree/src`);
    expect(viaQuery.status).toBe(200);
    expect(viaSegment.status).toBe(200);
    // Body should contain the same paths (order preserved by both).
    expect(viaQuery.body.trim()).toBe(viaSegment.body.trim());
  });

  test("/tree?path=src is strictly smaller than full tree", async () => {
    const full = await getText(`/${REPO}/tree?count=1`);
    const scoped = await getText(`/${REPO}/tree?path=src&count=1`);
    expect(Number(scoped.body.trim())).toBeLessThan(Number(full.body.trim()));
    expect(Number(scoped.body.trim())).toBeGreaterThan(0);
  });

  test("/tree?path=src/middleware works for nested subtrees", async () => {
    const { status, body } = await getText(`/${REPO}/tree?path=src/middleware`);
    expect(status).toBe(200);
    for (const line of body.trim().split("\n")) {
      expect(line.startsWith("src/middleware")).toBe(true);
    }
  });

  test("/tree.json?path= returns the same entries as the segment form", async () => {
    const q = await getJson<any>(`/${REPO}/tree.json?path=src/middleware`);
    const s = await getJson<any>(`/${REPO}/tree.json/src/middleware`);
    expect(q.status).toBe(200);
    expect(s.status).toBe(200);
    expect(q.body.count).toBe(s.body.count);
  });
});

describe("/grep?path= scopes search", () => {
  test("/grep?path=src/middleware narrows to subtree", async () => {
    const unscoped = await getJson<any>(
      `/${REPO}/grep?q=middleware&files_only=1&limit=1000`,
    );
    const scoped = await getJson<any>(
      `/${REPO}/grep?q=middleware&files_only=1&limit=1000&path=src/middleware`,
    );
    expect(unscoped.status).toBe(200);
    expect(scoped.status).toBe(200);
    expect(scoped.body.files.length).toBeLessThanOrEqual(unscoped.body.files.length);
    for (const f of scoped.body.files) {
      expect(f.startsWith("src/middleware")).toBe(true);
    }
  });

  test("/grep?path=single/file.ts scopes to exactly that file", async () => {
    const { status, body } = await getJson<any>(
      `/${REPO}/grep?q=Hono&path=src/hono.ts&files_only=1`,
    );
    expect(status).toBe(200);
    for (const f of body.files) expect(f).toBe("src/hono.ts");
  });

  test("/grep?path= still combines with exclude_glob", async () => {
    const { body } = await getJson<any>(
      `/${REPO}/grep?q=.&regex=1&path=src&exclude_glob=**/*.test.ts&files_only=1&limit=1000`,
    );
    for (const f of body.files) {
      expect(f.startsWith("src")).toBe(true);
      expect(f.endsWith(".test.ts")).toBe(false);
    }
  });
});

describe("/outline?path= aliases /outline/<path>", () => {
  test("query-param form returns same body as segment form", async () => {
    const q = await getJson<any>(`/${REPO}/outline?path=src/hono.ts`);
    const s = await getJson<any>(`/${REPO}/outline/src/hono.ts`);
    expect(q.status).toBe(200);
    expect(s.status).toBe(200);
    expect(q.body.language).toBe(s.body.language);
    expect(q.body.totalLines).toBe(s.body.totalLines);
    expect(q.body.items.length).toBe(s.body.items.length);
  });
});

describe("empty/invalid path= is rejected explicitly, not swallowed", () => {
  test("/tree?path= → 400", async () => {
    const { status, body } = await getJson(`/${REPO}/tree?path=`);
    expect(status).toBe(400);
    expect(body.error).toBe("bad_path_param");
  });
  test("/grep?path= → 400", async () => {
    const { status, body } = await getJson(`/${REPO}/grep?q=foo&path=`);
    expect(status).toBe(400);
    expect(body.error).toBe("bad_path_param");
  });
  test("/outline?path= → 400", async () => {
    const { status, body } = await getJson(`/${REPO}/outline?path=`);
    expect(status).toBe(400);
  });
});
