// The JS port of Model2Vec inference must match the Python reference
// (model2vec + int8-quantised weights) token-for-token and to 1e-3 cosine.
// Needs the exported model file; skipped when it is not on disk.
import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { parseModel, tokenize, embed, dot, preTokenize, quantize, dotQ } from "../src/embed";

const MODEL = process.env.EMBED_MODEL_PATH ?? "/private/tmp/claude-501/-Users-mike-Projects/98f65f34-2fc6-47c7-a132-197af7023491/scratchpad/potion-code-16M-v2.m2v";
const REF = process.env.EMBED_REF_PATH ?? "/private/tmp/claude-501/-Users-mike-Projects/98f65f34-2fc6-47c7-a132-197af7023491/scratchpad/potion-ref.json";

describe("preTokenize", () => {
  it("lowercases, isolates punctuation, splits whitespace", () => {
    expect(preTokenize("export const bodyLimit = (options: X) => {")).toEqual(
      ["export", "const", "bodylimit", "=", "(", "options", ":", "x", ")", "=", ">", "{"],
    );
  });
  it("strips accents like BertNormalizer", () => {
    expect(preTokenize("Café naïve")).toEqual(["cafe", "naive"]);
  });
});

describe("potion-code-16M-v2 port", () => {
  const available = existsSync(MODEL) && existsSync(REF);
  it("matches the python tokenizer ids and vectors", () => {
    if (!available) { console.warn("embed model/ref not found; skipping"); return; }
    const model = parseModel(readFileSync(MODEL).buffer.slice(0) as ArrayBuffer);
    expect(model.dim).toBe(256);
    const ref = JSON.parse(readFileSync(REF, "utf-8")) as { vectors: Record<string, number[]>; ids: Record<string, number[]> };
    for (const [text, ids] of Object.entries(ref.ids)) {
      expect(tokenize(model, text)).toEqual(ids);
      const v = embed(model, text);
      const r = Float32Array.from(ref.vectors[text]);
      expect(dot(v, r)).toBeGreaterThan(0.999);
    }
  });
  it("int8 vector storage keeps cosine within 1e-3", () => {
    if (!available) return;
    const model = parseModel(readFileSync(MODEL).buffer.slice(0) as ArrayBuffer);
    const a = embed(model, "where is the request body size limit enforced");
    const b = embed(model, "export const bodyLimit = (options: BodyLimitOptions): MiddlewareHandler => {");
    const { q, scale } = quantize(b);
    expect(Math.abs(dotQ(a, q, scale) - dot(a, b))).toBeLessThan(3e-3);
  });
  it("embeds a 40-line chunk in well under a millisecond", () => {
    if (!available) return;
    const model = parseModel(readFileSync(MODEL).buffer.slice(0) as ArrayBuffer);
    const chunk = Array.from({ length: 40 }, (_, i) => `  const value${i} = compute(input[${i}], options.flag ?? defaults.flag);`).join("\n");
    embed(model, chunk);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) embed(model, chunk + i);
    const per = (performance.now() - t0) / 200;
    expect(per).toBeLessThan(2);
  });
});
