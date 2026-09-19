// Semantic endpoints (TypeSafe Jev). Live integration against BASE, plus
// pure unit tests for the query planner. Skips the live half when the
// deployment has no TYPESAFE_API_KEY (503 semantic_unavailable).
import { describe, it, expect, beforeAll } from "bun:test";
import { getJson, getText, prewarm } from "./common";
import { planQuery } from "../src/semantic";

const HONO = "honojs/hono@cf2d2b7edcf07adef2db7614557f4d7f9e2be7ba";
const OPENCODE = "sst/opencode@8cc2c81d57f7c3ca8942d0e2461bc676bd25e8cc";
const REACT = "facebook/react@7aa5dda3b3e4c2baa905a59b922ae7ec14734b24";

const enc = (s: string) => encodeURIComponent(s);

describe("planQuery (unit)", () => {
  it("pulls quoted literals out verbatim", () => {
    const p = planQuery('the literal string `4 out of 5 people` appears in which file');
    expect(p.literals).toEqual(["4 out of 5 people"]);
    expect(p.identifiers).toEqual([]);
  });
  it("recognises code-shaped identifiers and drops stopwords", () => {
    const p = planQuery("where is the bodyLimit middleware defined in src/hono.ts and MAX_SIZE");
    expect(p.identifiers).toContain("bodyLimit");
    expect(p.identifiers).toContain("src/hono.ts");
    expect(p.identifiers).toContain("MAX_SIZE");
    expect(p.words).not.toContain("the");
    expect(p.words).not.toContain("where");
  });
  it("keeps plain words for path hints", () => {
    const p = planQuery("which file handles websocket upgrade");
    expect(p.words).toContain("websocket");
    expect(p.words).toContain("upgrade");
  });
});

let semanticAvailable = false;

describe("semantic endpoints (live)", () => {
  beforeAll(async () => {
    await prewarm(HONO);
    const probe = await getJson(`/${HONO}/find?q=${enc("where is the bodyLimit middleware defined")}`);
    semanticAvailable = probe.status === 200;
    if (!semanticAvailable) console.warn(`semantic endpoints unavailable (${probe.status}); skipping live tests`);
  });

  it("/find locates a symbol from a plain question, with headers and a pinned next URL", async () => {
    if (!semanticAvailable) return;
    const r = await getJson(`/${HONO}/find?q=${enc("where is the bodyLimit middleware defined")}`);
    expect(r.status).toBe(200);
    expect(r.body.hits[0].path).toBe("src/middleware/body-limit/index.ts");
    expect(r.body.hits[0].line).toBe(57);
    expect(r.body.exists).toBeGreaterThan(0.7);
    expect(r.body.confidence).toBeGreaterThan(0.5);
    expect(r.body.hits[0].next).toStartWith(`/${HONO}/file/src/middleware/body-limit/index.ts?lines=57-`);
    expect(r.body.hits[0].snippet).toContain("57 | export const bodyLimit");
    expect(r.headers.get("x-gitvfs-jev-requests")).not.toBeNull();
    expect(r.headers.get("x-gitvfs-exists")).toBe(String(r.body.exists));
    expect(r.headers.get("x-gitvfs-semantic-cache")).toMatch(/^(hit|miss)$/);
  });

  it("/find is cached per (sha, question): second call makes zero model requests", async () => {
    if (!semanticAvailable) return;
    const q = `q=${enc("where is the bodyLimit middleware defined")}`;
    await getJson(`/${HONO}/find?${q}`);
    const r = await getJson(`/${HONO}/find?${q}`);
    expect(r.headers.get("x-gitvfs-semantic-cache")).toBe("hit");
    expect(r.headers.get("x-gitvfs-jev-requests")).toBe("0");
  });

  it("/find uses literal grep for quoted strings on a large repo (beam search)", async () => {
    if (!semanticAvailable) return;
    const r = await getJson(`/${OPENCODE}/find?q=${enc('the literal string "4 out of 5 people on our team love using" appears in a React/Solid component file, not the i18n table. Which file and line?')}`);
    expect(r.status).toBe(200);
    expect(r.body.stages.grep.literals).toEqual(["4 out of 5 people on our team love using"]);
    expect(r.body.hits[0].path).toBe("packages/console/app/src/routes/zen/index.tsx");
    expect(r.body.hits[0].line).toBe(238);
    expect(r.body.stages.paths.total).toBeGreaterThan(220);
  });

  it("/ask inlines the top hit's source", async () => {
    if (!semanticAvailable) return;
    const r = await getJson(`/${HONO}/ask?q=${enc("what is the version field in the root package.json")}`);
    expect(r.status).toBe(200);
    expect(r.body.hits[0].path).toBe("package.json");
    expect(r.body.source.path).toBe("package.json");
    expect(r.body.source.text).toContain('"version": "4.12.14"');
  });

  it("/find requires q and caps its length", async () => {
    const a = await getJson(`/${HONO}/find`);
    expect(a.status).toBe(400);
    expect(a.body.error).toBe("missing_q");
    const b = await getJson(`/${HONO}/find?q=${enc("x".repeat(601))}`);
    expect(b.status).toBe(400);
    expect(b.body.error).toBe("bad_q");
  });

  it("/file?about= ranks lines in one file and returns a slice", async () => {
    if (!semanticAvailable) return;
    const r = await getJson(`/${HONO}/file/src/middleware/body-limit/index.ts?about=${enc("what happens when the body is too large")}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.body.exists).toBeGreaterThan(0.7);
    expect(r.body.hits.length).toBeGreaterThan(0);
    expect(r.body.hits.map((h: any) => h.line)).toContain(104);
    expect(r.body.slice.text).toContain("BodyLimitError");
  });

  it("/locate is an alias of /file?about=", async () => {
    if (!semanticAvailable) return;
    const r = await getJson(`/${HONO}/locate/src/middleware/body-limit/index.ts?q=${enc("what happens when the body is too large")}`);
    expect(r.status).toBe(200);
    expect(r.body.path).toBe("src/middleware/body-limit/index.ts");
    expect(r.body.hits.length).toBeGreaterThan(0);
  });

  it("/grep?intent= puts the definition first and rejects files_only", async () => {
    if (!semanticAvailable) return;
    const r = await getJson(`/${HONO}/grep?q=bodyLimit&case=i&limit=40&intent=${enc("where is the bodyLimit middleware implemented")}`);
    expect(r.status).toBe(200);
    expect(r.body.ranked).toBe(true);
    expect(r.body.matches[0].path).toBe("src/middleware/body-limit/index.ts");
    expect(r.body.matches[0].line).toBe(57);
    expect(r.body.matches[0].relevance).toBeGreaterThan(0.7);
    expect(r.body.matches[0].inSymbol).toBe("bodyLimit");
    const t = await getText(`/${HONO}/grep?q=bodyLimit&case=i&limit=40&format=text&intent=${enc("where is the bodyLimit middleware implemented")}`);
    expect(t.body.split("\n")[0]).toMatch(/^\d\.\d\d\tsrc\/middleware\/body-limit\/index\.ts:57:/);
    const bad = await getJson(`/${HONO}/grep?q=bodyLimit&files_only=1&intent=x`);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("bad_params");
  });

  it("/verify supports a true claim and contradicts a false one", async () => {
    if (!semanticAvailable) return;
    const ok = await getJson(`/${HONO}/verify/package.json?lines=1-5&claim=${enc("the package version is 4.12.14")}`);
    expect(ok.status).toBe(200);
    expect(ok.body.verdict).toBe("supported");
    expect(ok.body.supported).toBeGreaterThan(0.8);
    expect(ok.headers.get("x-gitvfs-verdict")).toBe("supported");
    const no = await getJson(`/${HONO}/verify/package.json?lines=1-5&claim=${enc("the package version is 4.13.0")}`);
    expect(no.body.verdict).toBe("contradicted");
    expect(no.body.supported).toBeLessThan(0.2);
    const missing = await getJson(`/${HONO}/verify/package.json?lines=1-5`);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("missing_claim");
  });

  it("/tree?roles=1 tags entries and works in text and JSON", async () => {
    if (!semanticAvailable) return;
    const t = await getText(`/${HONO}/tree?depth=1&roles=1`);
    expect(t.status).toBe(200);
    expect(t.body).toContain("src/\tcore");
    expect(t.body).toContain(".github/\tci");
    expect(t.body).toContain("bun.lock\tgenerated");
    const j = await getJson(`/${HONO}/tree.json/src/middleware/body-limit?roles=1`);
    const test = j.body.entries.find((e: any) => e.path.endsWith("index.test.ts"));
    expect(test.role).toBe("tests");
    expect(typeof test.roleConfidence).toBe("number");
  });

  it("unknown /tree params come back with a suggested URL", async () => {
    if (!semanticAvailable) return;
    const r = await getJson(`/${HONO}/tree?subpath=src/middleware`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("unknown_query_param");
    expect(r.body.suggested).toStartWith(`/${HONO}/tree/src/middleware`);
  });

  it("/find answers a symbol-line question on react in one call", async () => {
    if (!semanticAvailable) return;
    const r = await getJson(`/${REACT}/find?q=${enc("on what line does `export function useState<S>(` begin in packages/react/src/ReactHooks.js")}`);
    expect(r.status).toBe(200);
    expect(r.body.hits[0].path).toBe("packages/react/src/ReactHooks.js");
    expect(r.body.hits[0].line).toBe(93);
  });
});
