import { describe, test, expect, beforeAll } from "bun:test";
import { getRaw, getJson, prewarm, BASE } from "./common";

const REPO = "honojs/hono";

beforeAll(async () => {
  await prewarm(REPO);
});

describe("x-gitvfs-source header", () => {
  test("cache-busted /tree reports source=do", async () => {
    // cache-bust guarantees we don't hit edge cache
    const res = await getRaw(`/${REPO}/tree?count=1`);
    expect(res.headers.get("x-gitvfs-source")).toBe("do");
  });

  test("identical repeat request reports source=edge", async () => {
    // Use stable URL (no cache-bust) so edge can hit.
    const stableUrl = `/${REPO}/tree?count=1&stable=${Date.now()}`;
    await getRaw(stableUrl, {}, { bust: false }); // prime
    await new Promise((r) => setTimeout(r, 1500));
    const res = await getRaw(stableUrl, {}, { bust: false });
    expect(res.headers.get("x-gitvfs-source")).toBe("edge");
  });

  test("/head on mutable ref reports source=ref-cache when cached", async () => {
    await getRaw(`/${REPO}/head?refresh=1`); // prime ref cache
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(`${BASE}/${REPO}/head`);
    expect(res.headers.get("x-gitvfs-source")).toBe("ref-cache");
  });

  test("/head?refresh=1 reports source=github", async () => {
    const res = await fetch(`${BASE}/${REPO}/head?refresh=1`);
    expect(res.headers.get("x-gitvfs-source")).toBe("github");
  });

  test("/head on SHA-pinned URL reports source=direct (no resolution needed)", async () => {
    const first = await fetch(`${BASE}/${REPO}/head`);
    const sha = (await first.json()).sha;
    const res = await fetch(`${BASE}/${REPO}@${sha}/head`);
    expect(res.headers.get("x-gitvfs-source")).toBe("direct");
  });
});
