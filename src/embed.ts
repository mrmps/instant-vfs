// Static code embeddings in the Worker: a port of Model2Vec inference for
// minishlab/potion-code-16M-v2 (MIT). No ML runtime needed: the model is a
// vocabulary → 256-d table; a text's embedding is the mean of its tokens'
// vectors, L2-normalised. Tokenisation is BERT WordPiece (lowercase, split
// on whitespace + punctuation, greedy longest-match with "##" continuations,
// [UNK] dropped), exactly as model2vec does with the HF tokenizer.
//
// The weights live in R2 as a single file written by
// bench/export-model.py: "M2V1" | u32 header length | JSON header
// {dim, vocab[], unk_id, median_token_length, max_length, ...} |
// float32 scale[V] | int8 matrix[V*dim]. Per-row int8 keeps cosine to the
// fp16 original at 0.9999. Loaded once per isolate and shared by every
// Durable Object it hosts.

export interface EmbedModel {
  name: string;
  dim: number;
  vocab: Map<string, number>;
  unkId: number;
  maxLength: number;
  medianTokenLength: number;
  maxInputCharsPerWord: number;
  scale: Float32Array;
  weights: Int8Array;
  // Pre-dequantised rows are cached lazily; most repos touch a small slice
  // of a 63k vocabulary.
  rowCache: Map<number, Float32Array>;
}

export function parseModel(buf: ArrayBuffer): EmbedModel {
  const u8 = new Uint8Array(buf);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== "M2V1") throw new Error(`embed model: bad magic ${magic}`);
  const headerLen = new DataView(buf, 4, 4).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + headerLen))) as {
    model: string; dim: number; vocab: string[]; unk_id: number; median_token_length: number;
    max_length: number; max_input_chars_per_word: number;
  };
  const V = header.vocab.length;
  let off = 8 + headerLen;
  const scale = new Float32Array(buf.slice(off, off + V * 4));
  off += V * 4;
  const weights = new Int8Array(buf, off, V * header.dim);
  const vocab = new Map<string, number>();
  header.vocab.forEach((t, i) => vocab.set(t, i));
  return {
    name: header.model, dim: header.dim, vocab, unkId: header.unk_id,
    maxLength: header.max_length ?? 512, medianTokenLength: header.median_token_length ?? 7,
    maxInputCharsPerWord: header.max_input_chars_per_word ?? 100,
    scale, weights, rowCache: new Map(),
  };
}

// ---- BERT normaliser + pre-tokeniser -------------------------------------

function isPunct(cp: number): boolean {
  // ASCII punctuation ranges as in BERT's _is_punctuation, plus Unicode P*.
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  if (cp < 128) return false;
  return /\p{P}/u.test(String.fromCodePoint(cp));
}
function isCJK(cp: number): boolean {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
}

// Split text into "words" the way BertPreTokenizer does after
// BertNormalizer(lowercase=true): lowercase + strip accents, control chars
// removed, CJK chars isolated, punctuation isolated, whitespace split.
export function preTokenize(text: string): string[] {
  const norm = text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();
  const words: string[] = [];
  let cur = "";
  for (const ch of norm) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd || (cp < 32 && cp !== 9 && cp !== 10 && cp !== 13)) continue;
    if (cp === 32 || cp === 9 || cp === 10 || cp === 13 || /\s/.test(ch)) {
      if (cur) { words.push(cur); cur = ""; }
      continue;
    }
    if (isPunct(cp) || isCJK(cp)) {
      if (cur) { words.push(cur); cur = ""; }
      words.push(ch);
      continue;
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words;
}

// Greedy longest-match WordPiece. Returns token ids with [UNK] removed
// (model2vec drops the unk id before pooling).
export function tokenize(model: EmbedModel, text: string): number[] {
  // model2vec truncates characters first (max_length × median token length), then ids.
  const maxChars = model.maxLength * model.medianTokenLength;
  const words = preTokenize(text.length > maxChars ? text.slice(0, maxChars) : text);
  const ids: number[] = [];
  for (const w of words) {
    if (w.length > model.maxInputCharsPerWord) continue; // → [UNK] → dropped
    let start = 0;
    const sub: number[] = [];
    let bad = false;
    while (start < w.length) {
      let end = w.length;
      let found = -1;
      while (start < end) {
        const piece = (start > 0 ? "##" : "") + w.slice(start, end);
        const id = model.vocab.get(piece);
        if (id !== undefined) { found = id; break; }
        end--;
      }
      if (found < 0) { bad = true; break; }
      sub.push(found);
      start = end;
    }
    if (!bad) ids.push(...sub);
    if (ids.length >= model.maxLength) break;
  }
  return ids.length > model.maxLength ? ids.slice(0, model.maxLength) : ids;
}

function row(model: EmbedModel, id: number): Float32Array {
  let r = model.rowCache.get(id);
  if (r) return r;
  const { dim } = model;
  r = new Float32Array(dim);
  const s = model.scale[id];
  const base = id * dim;
  for (let i = 0; i < dim; i++) r[i] = model.weights[base + i] * s;
  if (model.rowCache.size < 20000) model.rowCache.set(id, r);
  return r;
}

// Mean of token vectors, L2-normalised. Empty input → zero vector.
export function embed(model: EmbedModel, text: string): Float32Array {
  const ids = tokenize(model, text);
  const out = new Float32Array(model.dim);
  if (!ids.length) return out;
  for (const id of ids) {
    const r = row(model, id);
    for (let i = 0; i < model.dim; i++) out[i] += r[i];
  }
  let norm = 0;
  for (let i = 0; i < model.dim; i++) { out[i] /= ids.length; norm += out[i] * out[i]; }
  norm = Math.sqrt(norm) + 1e-32;
  for (let i = 0; i < model.dim; i++) out[i] /= norm;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Vectors are stored in SQLite as int8 (per-vector scale) to keep a 60k-chunk
// repo under ~16MB. Cosine on dequantised values is within 1e-3 of fp32.
export function quantize(v: Float32Array): { q: Int8Array; scale: number } {
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, Math.abs(v[i]));
  const scale = max / 127 || 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i] / scale);
  return { q, scale };
}
export function dotQ(query: Float32Array, q: Int8Array, scale: number): number {
  let s = 0;
  for (let i = 0; i < q.length; i++) s += query[i] * q[i];
  return s * scale;
}

// ---- Loading (shared per isolate) ----------------------------------------

let loaded: Promise<EmbedModel> | null = null;

export function loadModel(fetchBytes: () => Promise<ArrayBuffer>): Promise<EmbedModel> {
  if (!loaded) {
    loaded = fetchBytes().then(parseModel).catch((e) => { loaded = null; throw e; });
  }
  return loaded;
}

export const MODEL_KEY = "potion-code-16M-v2.m2v";
