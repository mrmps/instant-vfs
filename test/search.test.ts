// Hybrid search: chunking + BM25 unit tests, and live tests for /search,
// cross-repo /search?repos=, classify, and the index status on /status.
import { describe, it, expect, beforeAll } from "bun:test";
import { getJson, getText, prewarm } from "./common";
import { chunkFile, bm25Terms, termString, parseTf, termCount } from "../src/search-index";

const HONO = "honojs/hono@cf2d2b7edcf07adef2db7614557f4d7f9e2be7ba";
const enc = (s: string) => encodeURIComponent(s);

describe("chunkFile (unit)", () => {
  it("makes one chunk per top-level symbol and covers the gaps", () => {
    const src = [
      "import x from 'y'", "", "export function a() {", "  return 1", "}", "",
      "export class B {", "  m() { return 2 }", "}", "", "const tail = 3",
    ].join("\n");
    const chunks = chunkFile("src/f.ts", src);
    const syms = chunks.filter((c) => c.kind === "symbol").map((c) => c.symbol);
    expect(syms).toContain("a");
    expect(syms).toContain("B");
    // Every line is covered by some chunk.
    const covered = new Set<number>();
    for (const c of chunks) for (let L = c.start; L <= c.end; L++) covered.add(L);
    const srcLines = src.split("\n");
    for (let L = 1; L <= srcLines.length; L++) if (srcLines[L - 1].trim()) expect(covered.has(L)).toBe(true);
    for (const c of chunks) expect(c.text.startsWith("src/f.ts")).toBe(true);
  });
  it("windows long files with overlap and never exceeds the max chunk size", () => {
    const src = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkFile("README.md", src);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.end - c.start + 1).toBeLessThanOrEqual(60);
    expect(chunks[0].start).toBe(1);
    expect(chunks[chunks.length - 1].end).toBe(300);
  });
  it("returns nothing for empty files", () => {
    expect(chunkFile("empty.ts", "")).toEqual([]);
  });
});

describe("bm25Terms (unit)", () => {
  it("splits identifiers into parts and drops stopwords", () => {
    const t = bm25Terms("export const parseConfig = (body_limit) => {}");
    expect(t).toContain("parseconfig");
    expect(t).toContain("parse");
    expect(t).toContain("config");
    expect(t).toContain("body_limit");
    expect(t).toContain("body");
    expect(t).toContain("limit");
    expect(t).not.toContain("export");
    expect(t).not.toContain("const");
  });
  it("term strings round-trip counts", () => {
    const s = termString(["a", "b", "a", "config"]);
    expect(parseTf(s, "a")).toBe(2);
    expect(parseTf(s, "config")).toBe(1);
    expect(parseTf(s, "zzz")).toBe(0);
    expect(termCount(s)).toBe(3);
  });
});

let available = false;

describe("/search (live)", () => {
  beforeAll(async () => {
    await prewarm(HONO);
    // Drive the index to ready (small repo: one call).
    for (let i = 0; i < 10; i++) {
      const r = await getJson(`/${HONO}/search?q=${enc("body size limit")}&rerank=0`);
      if (r.status === 200) { available = true; break; }
      if (r.status !== 202) {
        // A deployed target without the model is an outage, not a skip —
        // unless the caller says the target is expected to lack it.
        const msg = `search unavailable (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`;
        if (process.env.GITVFS_ALLOW_UNAVAILABLE === "1") { console.warn(msg); break; }
        throw new Error(msg);
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
  });

  it("finds the body-limit middleware from a plain query (pure retrieval)", async () => {
    if (!available) return;
    const r = await getJson(`/${HONO}/search?q=${enc("reject requests whose body exceeds a configured size")}&rerank=0&k=5`);
    expect(r.status).toBe(200);
    expect(r.body.ranked).toBe(false);
    expect(r.body.chunks).toBeGreaterThan(1000);
    expect(r.body.hits[0].path).toBe("src/middleware/body-limit/index.ts");
    expect(r.body.hits[0].snippet).toMatch(/^\d+ \| /);
    expect(r.headers.get("x-gitvfs-chunks")).toBe(String(r.body.chunks));
    expect(r.headers.get("x-gitvfs-jev-requests")).toBe("0");
  });

  it("reranks with Jev and reports relevance", async () => {
    if (!available) return;
    const r = await getJson(`/${HONO}/search?q=${enc("reject requests whose body exceeds a configured size")}&k=5`);
    expect(r.status).toBe(200);
    if (r.headers.get("x-gitvfs-semantic") === "unavailable") return;
    expect(r.body.ranked).toBe(true);
    expect(r.body.hits[0].path).toBe("src/middleware/body-limit/index.ts");
    expect(r.body.hits[0].relevance).toBeGreaterThan(0.6);
    expect(r.body.hits[0].symbol).toBe("bodyLimit");
  });

  it("classifies hits with caller-supplied labels", async () => {
    if (!available) return;
    const r = await getJson(`/${HONO}/search?q=${enc("jwt token verification")}&k=6&classify=definition,usage,test,docs`);
    expect(r.status).toBe(200);
    if (r.headers.get("x-gitvfs-semantic") === "unavailable") return;
    expect(r.body.labels).toEqual(["definition", "usage", "test", "docs"]);
    for (const h of r.body.hits) {
      expect(["definition", "usage", "test", "docs"]).toContain(h.label);
      expect(typeof h.labelConfidence).toBe("number");
    }
  });

  it("scopes with ?glob= and supports format=text", async () => {
    if (!available) return;
    const r = await getJson(`/${HONO}/search?q=${enc("websocket upgrade")}&k=5&glob=${enc("src/adapter/**")}&rerank=0`);
    expect(r.status).toBe(200);
    for (const h of r.body.hits) expect(h.path).toStartWith("src/adapter/");
    const t = await getText(`/${HONO}/search?q=${enc("websocket upgrade")}&k=3&rerank=0&format=text`);
    expect(t.status).toBe(200);
    expect(t.body.split("\n")[0]).toMatch(/^src\/.+:\d+-\d+/);
  });

  it("rejects a missing query and exposes index state on /status", async () => {
    const a = await getJson(`/${HONO}/search`);
    expect(a.status).toBe(400);
    expect(a.body.error).toBe("missing_q");
    const s = await getJson(`/${HONO}/status`);
    expect(s.status).toBe(200);
    expect(s.body.index).toBeDefined();
    if (available) expect(s.body.index.state).toBe("ready");
  });

  it("searches several repos in one call", async () => {
    if (!available) return;
    // Retry while cold repos ingest/index.
    let r: any;
    for (let i = 0; i < 12; i++) {
      r = await getJson(`/search?q=${enc("parse command line option flags")}&repos=${enc("tj/commander.js,honojs/hono@cf2d2b7edcf07adef2db7614557f4d7f9e2be7ba")}&k=6`);
      if (r.status === 200 && !r.body.pending) break;
      await new Promise((res) => setTimeout(res, 3000));
    }
    expect(r.status).toBe(200);
    expect(r.body.repos.length).toBe(2);
    expect(r.body.hits.length).toBeGreaterThan(0);
    expect(r.body.hits[0].repo).toBe("tj/commander.js");
    expect(r.body.hits[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("/search?repos= validates its inputs", async () => {
    const a = await getJson(`/search?q=x`);
    expect(a.status).toBe(400);
    expect(a.body.error).toBe("missing_repos");
    const b = await getJson(`/search?repos=a/b`);
    expect(b.status).toBe(400);
    expect(b.body.error).toBe("missing_q");
  });
});
