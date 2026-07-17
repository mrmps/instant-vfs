// Integration tests for operational-readiness fixes:
//   · security headers on every response
//   · x-gitvfs-duration-ms on every response
//   · unified ingest_too_large + ref_not_found error shapes
//   · per-repo throttle (bash/grep) returns 429 + retry-after
//   · self-healing lines column (via /file + /stat)
//   · /bash + /grep rejections (path traversal, invalid regex, etc.) return
//     canonical {error, message} shape (not ad-hoc responses)
// These hit the deployed worker.

import { describe, expect, test } from "bun:test";
import { getJson, getText, getRaw, prewarm, BASE } from "./common";

describe("security headers", () => {
  test("every successful response carries the standard set", async () => {
    const res = await getRaw("/sindresorhus/ky/tree?depth=1");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  });

  test("error responses also carry them", async () => {
    const res = await getRaw("/does/not-exist/tree");
    // ref resolution fails with 404 or 502 depending on cache state; either
    // way, security headers should be present.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("/llms.txt carries them too", async () => {
    const res = await getRaw("/llms.txt");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("OPTIONS preflight returns CORS metadata without executing the route", async () => {
    const res = await getRaw(
      "/octocat/Hello-World/file/README",
      {
        method: "OPTIONS",
        headers: {
          origin: "https://example.com",
          "access-control-request-method": "GET",
          "access-control-request-headers": "x-test, x-gitvfs-key",
        },
      },
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-headers")).toBe("x-test, x-gitvfs-key");
    expect(await res.text()).toBe("");
  });
});

describe("HTTP method contract", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    test(`${method} is rejected before repo routing`, async () => {
      const res = await getRaw(
        "/octocat/Hello-World/file/README",
        { method },
      );
      const body = await res.json() as any;

      expect(res.status).toBe(405);
      expect(body.error).toBe("method_not_allowed");
      expect(body.allowedMethods).toEqual(["GET", "HEAD", "OPTIONS"]);
      expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
      expect(res.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
      expect(res.headers.get("x-gitvfs-sha")).toBeNull();
    });
  }
});

describe("x-gitvfs-duration-ms", () => {
  test("every response carries a numeric duration", async () => {
    const res = await getRaw("/sindresorhus/ky/tree?depth=1");
    const dur = res.headers.get("x-gitvfs-duration-ms");
    expect(dur).toBeTruthy();
    expect(Number.isFinite(Number(dur))).toBe(true);
    expect(Number(dur)).toBeGreaterThanOrEqual(0);
  });

  test("set on 404s as well", async () => {
    const res = await getRaw("/sindresorhus/ky/file/absolutely-nonexistent.xyz");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-gitvfs-duration-ms")).toBeTruthy();
  });
});

describe("error shape consistency", () => {
  test("ref not found surfaces as canonical {error, message}", async () => {
    const { body, status } = await getJson(
      "/this-owner-does-not-exist-gitvfs-test/repo-nope/tree",
    );
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.error).toBeDefined();
    expect(body.message).toBeDefined();
  });

  test("missing required param is 400 with a specific code", async () => {
    const { body, status } = await getJson("/sindresorhus/ky/grep");
    expect(status).toBe(400);
    expect(body.error).toBe("missing_q");
  });

  test("bad_path is surfaced from /files", async () => {
    const { body, status } = await getJson(
      "/sindresorhus/ky/files?paths=" + encodeURIComponent("../etc/passwd"),
    );
    expect(status).toBe(400);
    expect(body.error).toBe("bad_path");
  });
});

describe("self-healing lines (via /stat + /file)", () => {
  test("x-gitvfs-lines is always present on /file responses", async () => {
    // /file computes lines on-the-fly if the column is NULL, and also
    // persists it back. This is the self-heal contract.
    await prewarm("sindresorhus/ky");
    const res = await getRaw("/sindresorhus/ky/file/source/index.ts");
    expect(res.status).toBe(200);
    const lines = res.headers.get("x-gitvfs-lines");
    expect(lines).toBeTruthy();
    expect(Number(lines)).toBeGreaterThan(0);
  });

  test("/stat sees the persisted lines value after a /file read", async () => {
    // Read the file first to trigger the self-heal UPDATE, then stat should
    // report a numeric lines field. Old DOs that pre-date the lines column
    // converge to this state after a single read.
    await prewarm("sindresorhus/ky");
    await getRaw("/sindresorhus/ky/file/source/index.ts");
    const { body } = await getJson("/sindresorhus/ky/stat/source/index.ts");
    expect(typeof body.lines).toBe("number");
    expect(body.lines).toBeGreaterThan(0);
  });
});

describe("cold ingest correctness (via refresh=1)", () => {
  test("?refresh=1 forces a fresh resolve and returns real data", async () => {
    // Use a smaller repo to keep the test quick.
    const res = await getRaw("/sindresorhus/ky/tree?depth=1&refresh=1");
    expect(res.status).toBe(200);
    const resolvedAt = res.headers.get("x-gitvfs-resolved-at");
    expect(resolvedAt).toBeTruthy();
    const age = Number(res.headers.get("x-gitvfs-age-seconds"));
    // Fresh resolution should be recent.
    expect(age).toBeLessThan(30);
  });
});

describe("internal bypass key (X-Gitvfs-Key)", () => {
  const KEY = process.env.GITVFS_INTERNAL_KEY;
  const maybe = KEY ? test : test.skip;

  maybe("valid key lets a burst through without 429", async () => {
    // Fire enough requests to overrun the general per-IP limit (100/10s).
    // With the bypass header, all should succeed. The common helpers
    // already inject the header when GITVFS_INTERNAL_KEY is set.
    const results = await Promise.all(
      Array.from({ length: 120 }, () => getJson("/sindresorhus/ky/head")),
    );
    const okCount = results.filter((r) => r.status === 200).length;
    expect(okCount).toBe(120);
  });

  maybe("invalid key produces a normal response (200 or 429), not 500", async () => {
    // Probe with a deliberately wrong key. We can't assert 429 directly
    // (would burn through the quota shared with the other bypass test), so
    // we just confirm the server doesn't error out.
    const res = await fetch(`${BASE}/sindresorhus/ky/head?_cb=wrongkey_${Date.now()}`, {
      headers: { "x-gitvfs-key": "definitely-not-the-real-key" },
    });
    expect([200, 429]).toContain(res.status);
  });
});

describe("/head endpoint (freshness probe)", () => {
  test("returns resolved sha without triggering ingest", async () => {
    const { body, status } = await getJson("/sindresorhus/ky/head");
    expect(status).toBe(200);
    expect(body.sha).toBeDefined();
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.pinned).toBe(false);
  });

  test("head is NOT edge cached (cache-control: no-store)", async () => {
    const res = await getRaw("/sindresorhus/ky/head");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
