// Staleness-visible design: agents need to know how old the data is and have
// an explicit knob to force fresh. These tests pin down that contract.
import { describe, test, expect, beforeAll } from "bun:test";
import { getRaw, getJson, prewarm } from "./common";

const REPO = "honojs/hono";

beforeAll(async () => {
  await prewarm(REPO);
});

describe("Freshness headers on every response", () => {
  test("/tree carries sha, ref, resolved-at, age-seconds, pinned=false, pin-hint", async () => {
    const res = await getRaw(`/${REPO}/tree?count=1`);
    expect(res.status).toBe(200);
    const h = res.headers;
    expect(h.get("x-gitvfs-sha")).toMatch(/^[0-9a-f]{40}$/);
    expect(h.get("x-gitvfs-pinned")).toBe("false");
    expect(h.get("x-gitvfs-mutable")).toBe("true");
    expect(h.get("x-gitvfs-resolved-at")).not.toBeNull();
    expect(h.get("x-gitvfs-age-seconds")).not.toBeNull();
    expect(Number(h.get("x-gitvfs-age-seconds"))).toBeGreaterThanOrEqual(0);
    expect(h.get("x-gitvfs-pin-hint")).toMatch(new RegExp(`^/${REPO}@[0-9a-f]{40}/`));
  });

  test("SHA-pinned URL has pinned=true and no resolvedAt/age", async () => {
    const { body } = await getJson<any>(`/${REPO}/head`);
    const fullSha = body.sha;
    const res = await getRaw(`/${REPO}@${fullSha}/tree?count=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gitvfs-pinned")).toBe("true");
    expect(res.headers.get("x-gitvfs-mutable")).toBe("false");
    expect(res.headers.get("x-gitvfs-resolved-at")).toBeNull();
    expect(res.headers.get("x-gitvfs-age-seconds")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("immutable");
  });
});

describe("/head endpoint", () => {
  test("returns {sha, resolvedAt, pinned, ageSeconds, fromCache}", async () => {
    const { status, body } = await getJson<any>(`/${REPO}/head`);
    expect(status).toBe(200);
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.pinned).toBe(false);
    expect(typeof body.resolvedAt).toBe("string");
    expect(typeof body.ageSeconds).toBe("number");
    expect(typeof body.fromCache).toBe("boolean");
  });

  test("/head is cheap: never triggers ingest for a never-seen repo", async () => {
    // Use a small, unusual repo — even if never warmed, /head shouldn't fetch a tarball.
    const t0 = performance.now();
    const { status, body } = await getJson<any>(`/sindresorhus/slugify/head`);
    const dt = performance.now() - t0;
    expect(status).toBe(200);
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);
    // Should be essentially a single GitHub API call. Allow up to 2s for a cold ref fetch.
    expect(dt).toBeLessThan(2000);
  });

  test("/head on SHA-pinned ref has pinned=true and no GitHub call", async () => {
    const { body: first } = await getJson<any>(`/${REPO}/head`);
    const sha = first.sha;
    const { status, body } = await getJson<any>(`/${REPO}@${sha}/head`);
    expect(status).toBe(200);
    expect(body.pinned).toBe(true);
    expect(body.sha).toBe(sha);
    expect(body.resolvedAt).toBeNull();
  });
});

describe("Ref→SHA cache (24h TTL)", () => {
  test("second call to /head returns fromCache=true, age>0", async () => {
    // Prime the cache (refresh=1 forces a fresh resolution).
    await getJson(`/${REPO}/head?refresh=1`);
    // Give edge cache a couple seconds to persist and bump age.
    await new Promise((r) => setTimeout(r, 2500));
    // Retry up to 3 times — ctx.waitUntil persistence is eventually-consistent
    // across Cloudflare's edge.
    let body: any;
    for (let i = 0; i < 3; i++) {
      const res = await getJson<any>(`/${REPO}/head`);
      body = res.body;
      if (body.fromCache && body.ageSeconds > 0) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    expect(body.fromCache).toBe(true);
    expect(body.ageSeconds).toBeGreaterThan(0);
  });
});

describe("?refresh=1 bypasses ref cache", () => {
  test("refresh=1 resets resolvedAt and fromCache=false", async () => {
    // First, confirm cache is warm.
    await getJson(`/${REPO}/head`);
    await new Promise((r) => setTimeout(r, 500));
    const cached = await getJson<any>(`/${REPO}/head`);
    expect(cached.body.fromCache).toBe(true);

    // Now refresh.
    const fresh = await getJson<any>(`/${REPO}/head?refresh=1`);
    expect(fresh.body.fromCache).toBe(false);
    expect(fresh.body.ageSeconds).toBe(0);
    // resolvedAt must be newer than the cached one.
    expect(new Date(fresh.body.resolvedAt).getTime())
      .toBeGreaterThan(new Date(cached.body.resolvedAt).getTime());
  });

  test("refresh=1 on /tree resets age-seconds to 0", async () => {
    // We can't rely on exact cache timing across test runs, so just assert
    // the refresh path forces age=0 and a new resolvedAt.
    const fresh = await getRaw(`/${REPO}/tree?count=1&refresh=1`);
    const age = Number(fresh.headers.get("x-gitvfs-age-seconds"));
    const resolvedAt = fresh.headers.get("x-gitvfs-resolved-at");
    expect(age).toBe(0);
    expect(resolvedAt).not.toBeNull();
    // Confirmed: refresh=1 re-resolved and zeroed age.
  });

  test("after refresh, a subsequent non-refresh /tree sees age > 0 from cache", async () => {
    // Force a fresh resolution.
    await getRaw(`/${REPO}/tree?count=1&refresh=1`);
    // Wait for ctx.waitUntil(cache.put) to land.
    await new Promise((r) => setTimeout(r, 2500));
    // Now a non-refresh call should pick up the cached resolution with age >= 1s.
    const cached = await getRaw(`/${REPO}/tree?count=1`);
    const age = Number(cached.headers.get("x-gitvfs-age-seconds"));
    expect(age).toBeGreaterThan(0);
  });
});

describe("Agent workflow: pin-then-use", () => {
  test("agent reads pin-hint, then uses it — response is fully pinned", async () => {
    const res = await getRaw(`/${REPO}/tree?count=1`);
    const pinUrl = res.headers.get("x-gitvfs-pin-hint");
    expect(pinUrl).not.toBeNull();
    const pinned = await getRaw(pinUrl!);
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get("x-gitvfs-pinned")).toBe("true");
    expect(pinned.headers.get("cache-control")).toContain("immutable");
  });
});

describe("Agent workflow: has-this-moved?", () => {
  test("compare last-known sha against /head", async () => {
    // Agent remembers a sha from a prior session.
    const { body: first } = await getJson<any>(`/${REPO}/head`);
    const lastKnown = first.sha;

    // Later, agent checks. One cheap call.
    const { body: check } = await getJson<any>(`/${REPO}/head`);
    const moved = check.sha !== lastKnown;
    expect(typeof moved).toBe("boolean"); // just show the pattern works
    // Between two back-to-back /head calls, it won't have moved.
    expect(moved).toBe(false);
  });
});
