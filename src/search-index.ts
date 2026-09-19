// Hybrid code search over one repo snapshot: static embeddings
// (potion-code-16M-v2, src/embed.ts) fused with BM25, the same recipe as
// Minish Lab's semble, built inside the Durable Object so a repo is searchable
// milliseconds after it is ingested.
//
// Pure functions live here (chunking, tokenising, scoring); the DO owns the
// SQLite table and the in-memory matrix (src/repo-do.ts).

import { outline, detectLanguage, type OutlineItem } from "./outline";
import { embed, quantize, dotQ, type EmbedModel } from "./embed";

export type Chunk = {
  path: string;
  start: number;      // 1-based inclusive
  end: number;
  symbol?: string;
  kind: "symbol" | "window" | "file";
  text: string;       // what gets embedded (path + symbol + code)
};

export const CHUNK_MAX_LINES = 60;
export const CHUNK_WINDOW = 40;
export const CHUNK_STRIDE = 30;
export const CHUNK_MAX_CHARS = 2400;   // model truncates at 512 tokens anyway

function splitLogicalLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function flatten(items: OutlineItem[]): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const it of items) { out.push(it); if (it.children) out.push(...flatten(it.children)); }
  return out;
}

// Symbol-aware chunking: every top-level symbol is one chunk (split into
// overlapping windows when longer than CHUNK_MAX_LINES); the code between
// symbols and files without an outline fall back to fixed windows.
export function chunkFile(path: string, content: string): Chunk[] {
  const lines = splitLogicalLines(content);
  if (!lines.length) return [];
  const language = detectLanguage(path);
  const out: Chunk[] = [];
  const push = (start: number, end: number, symbol: string | undefined, kind: Chunk["kind"]) => {
    const body = lines.slice(start - 1, end).join("\n");
    if (!body.trim()) return;
    const head = `${path}${symbol ? `\n${kind === "symbol" ? "symbol" : ""} ${symbol}` : ""}\n`;
    out.push({ path, start, end, symbol, kind, text: (head + body).slice(0, CHUNK_MAX_CHARS) });
  };
  const windows = (start: number, end: number, symbol?: string, kind: Chunk["kind"] = "window") => {
    if (end - start + 1 <= CHUNK_MAX_LINES) { push(start, end, symbol, kind); return; }
    for (let s = start; s <= end; s += CHUNK_STRIDE) {
      push(s, Math.min(end, s + CHUNK_WINDOW - 1), symbol, kind);
      if (s + CHUNK_WINDOW - 1 >= end) break;
    }
  };

  let spans: Array<{ start: number; end: number; symbol: string }> = [];
  if (language !== "text") {
    const o = outline(path, content, { depth: 1 });
    spans = o.items
      .filter((it) => it.line >= 1)
      .map((it) => ({ start: it.line, end: Math.min(lines.length, it.endLine ?? it.line), symbol: it.name }))
      .sort((a, b) => a.start - b.start);
    // Symbols without a detected end run to the next symbol's start.
    for (let i = 0; i < spans.length; i++) {
      if (spans[i].end <= spans[i].start) spans[i].end = Math.min(lines.length, (spans[i + 1]?.start ?? lines.length + 1) - 1);
      if (i > 0 && spans[i].start <= spans[i - 1].end) spans[i - 1].end = spans[i].start - 1; // no overlaps
    }
    spans = spans.filter((s) => s.end >= s.start);
  }
  if (!spans.length) {
    windows(1, lines.length, undefined, lines.length <= CHUNK_MAX_LINES ? "file" : "window");
    return out;
  }
  let cursor = 1;
  for (const s of spans) {
    if (s.start > cursor) windows(cursor, s.start - 1);            // gap before the symbol
    windows(s.start, s.end, s.symbol, "symbol");
    cursor = s.end + 1;
  }
  if (cursor <= lines.length) windows(cursor, lines.length);
  return out;
}

// ---- BM25 side -----------------------------------------------------------

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "have", "has", "not", "but", "you", "your", "can", "will", "into", "than", "then", "when", "where", "which", "what", "how", "does", "did", "each", "any", "all", "its", "our", "out", "get", "set", "use", "used", "using", "return", "returns", "const", "let", "var", "function", "import", "export", "default", "from", "new", "null", "undefined", "true", "false", "void", "type", "interface", "class", "public", "private", "static", "async", "await", "this", "self", "def", "end", "if", "else", "elif", "for", "while", "in", "of", "to", "is", "as", "on", "at", "by", "or", "an", "a"]);

// Identifier-aware terms: whole identifiers plus their camelCase / snake_case
// parts, lowercased, so "parse config" matches parseConfig and parse_config.
export function bm25Terms(text: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z_$][A-Za-z0-9_$]*|\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const tok = m[0];
    const lower = tok.toLowerCase();
    if (lower.length >= 2 && !STOP.has(lower)) out.push(lower);
    if (/[a-z][A-Z]|_/.test(tok)) {
      for (const part of tok.split(/_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
        const p = part.toLowerCase();
        if (p.length >= 3 && p !== lower && !STOP.has(p)) out.push(p);
      }
    }
  }
  return out;
}

// Serialise a chunk's terms as " t1:3 t2:1 " so membership is a substring test.
export function termString(terms: string[]): string {
  const tf = new Map<string, number>();
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  let s = " ";
  for (const [t, n] of tf) s += `${t}:${n} `;
  return s;
}

export function parseTf(termStr: string, term: string): number {
  const i = termStr.indexOf(` ${term}:`);
  if (i < 0) return 0;
  const j = termStr.indexOf(" ", i + term.length + 2);
  return Number(termStr.slice(i + term.length + 2, j)) || 0;
}

export function termCount(termStr: string): number {
  let n = 0;
  for (let i = 0; i < termStr.length; i++) if (termStr.charCodeAt(i) === 58) n++; // ':'
  return n;
}

// ---- In-memory matrix ----------------------------------------------------

export interface IndexRow {
  id: number;
  path: string;
  start: number;
  end: number;
  symbol: string | null;
  kind: string;
  terms: string;
  scale: number;
}

export class SearchMatrix {
  rows: IndexRow[] = [];
  vecs: Int8Array;          // rows.length × dim
  dim: number;
  df = new Map<string, number>();
  avgLen = 1;
  constructor(dim: number, rows: IndexRow[], vecs: Int8Array) {
    this.dim = dim; this.rows = rows; this.vecs = vecs;
    let total = 0;
    for (const r of rows) {
      total += termCount(r.terms);
      const seen = new Set<string>();
      const re = / ([^ :]+):/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(r.terms))) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        this.df.set(m[1], (this.df.get(m[1]) ?? 0) + 1);
      }
    }
    this.avgLen = rows.length ? total / rows.length : 1;
  }

  search(model: EmbedModel, q: string, opts: { k?: number; filter?: (r: IndexRow) => boolean; perFile?: number; type?: "code" | "docs" | "all" } = {}): Array<IndexRow & { score: number; dense: number; bm25: number }> {
    const k = Math.max(1, Math.min(opts.k ?? 10, 200));
    const perFile = Math.max(1, opts.perFile ?? 2);
    const type = opts.type ?? "all";
    const typeFilter = type === "all" ? null : (r: IndexRow) => (isDocsPath(r.path) ? type === "docs" : type === "code");
    const baseFilter = opts.filter;
    if (typeFilter) opts = { ...opts, filter: baseFilter ? (r) => baseFilter(r) && typeFilter(r) : typeFilter };
    const n = this.rows.length;
    if (!n) return [];
    const qv = embed(model, q);
    const qTerms = [...new Set(bm25Terms(q))];
    const symbolLike = /[A-Za-z]+[A-Z_][A-Za-z0-9_]*|::|\.[a-z]+\(/.test(q) || (qTerms.length <= 2 && !/\s/.test(q.trim()));
    const dense = new Float32Array(n);
    const bm = new Float32Array(n);
    const K1 = 1.2, B = 0.75;
    const idf = qTerms.map((t) => {
      const d = this.df.get(t) ?? 0;
      return { t, idf: Math.log(1 + (n - d + 0.5) / (d + 0.5)) };
    }).filter((x) => x.idf > 0);
    for (let i = 0; i < n; i++) {
      const r = this.rows[i];
      if (opts.filter && !opts.filter(r)) { dense[i] = -2; bm[i] = -1; continue; }
      dense[i] = dotQ(qv, this.vecs.subarray(i * this.dim, (i + 1) * this.dim), r.scale);
      if (idf.length) {
        const len = termCount(r.terms);
        let s = 0;
        for (const { t, idf: w } of idf) {
          const tf = parseTf(r.terms, t);
          if (!tf) continue;
          s += w * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * len / this.avgLen));
        }
        bm[i] = s;
      }
    }
    // Reciprocal-rank fusion. Symbol-like queries lean lexical.
    const topN = Math.min(n, 100);
    const order = (arr: Float32Array) => Array.from({ length: n }, (_, i) => i).filter((i) => arr[i] > (arr === dense ? -2 : 0)).sort((a, b) => arr[b] - arr[a]).slice(0, topN);
    const wDense = symbolLike ? 0.6 : 1.0, wBm = symbolLike ? 1.4 : 1.0;
    const fused = new Map<number, number>();
    order(dense).forEach((i, r) => fused.set(i, (fused.get(i) ?? 0) + wDense / (60 + r)));
    order(bm).forEach((i, r) => fused.set(i, (fused.get(i) ?? 0) + wBm / (60 + r)));
    const scored = [...fused.entries()].map(([i, s]) => {
      const r = this.rows[i];
      let boost = 1;
      if (r.kind === "symbol") boost *= 1.15;
      if (/(^|\/)(__tests__|test|tests|spec|fixtures?|__snapshots__|__mocks__)(\/|$)|\.(test|spec)\.[a-z]+$|\.d\.ts$|\.snap$/.test(r.path)) boost *= 0.7;
      if (r.symbol && qTerms.some((t) => r.symbol!.toLowerCase().includes(t))) boost *= 1.2;
      // Prose is useful but should not crowd out the code it describes;
      // translated copies of the same page count once (see dedupe below).
      if (type === "all" && isDocsPath(r.path)) boost *= 0.8;
      return { i, s: s * boost };
    }).sort((a, b) => b.s - a.s);
    // Diversity: at most `perFile` chunks per file, and translated docs
    // (docs/<lang>/x.md, docs/x.<lang>.md) collapse onto one canonical page.
    const perFileCount = new Map<string, number>();
    const seenCanon = new Set<string>();
    const picked: Array<{ i: number; s: number }> = [];
    for (const c of scored) {
      const r = this.rows[c.i];
      const n = perFileCount.get(r.path) ?? 0;
      if (n >= perFile) continue;
      if (isDocsPath(r.path)) {
        // Same page in another language, same region → one result.
        const key = `${canonicalDocPath(r.path)}#${Math.floor(r.start / 40)}`;
        if (seenCanon.has(key)) continue;
        seenCanon.add(key);
      }
      perFileCount.set(r.path, n + 1);
      picked.push(c);
      if (picked.length >= k) break;
    }
    return picked.map(({ i, s }) => ({ ...this.rows[i], score: Math.round(s * 1e5) / 1e5, dense: Math.round(dense[i] * 1000) / 1000, bm25: Math.round(bm[i] * 100) / 100 }));
  }
}

export function isDocsPath(path: string): boolean {
  return /\.(md|mdx|rst|txt|adoc)$/i.test(path) || /(^|\/)(docs?|documentation|website|wiki)\//i.test(path);
}

// docs/fr/pages/x.md → docs/pages/x.md ; README.zh-CN.md → README.md
export function canonicalDocPath(path: string): string {
  return path
    .replace(/(^|\/)(docs?|documentation)\/([a-z]{2}(?:[-_][A-Za-z]{2,4})?)\//, "$1$2/")
    .replace(/\.([a-z]{2}(?:[-_][A-Za-z]{2,4})?)\.(md|mdx|rst)$/, ".$2")
    .replace(/(^|\/)i18n\/[^/]+\//, "$1");
}

export function embedChunk(model: EmbedModel, c: Chunk): { q: Int8Array; scale: number; terms: string } {
  const { q, scale } = quantize(embed(model, c.text));
  return { q, scale, terms: termString(bm25Terms(`${c.path.replace(/[\/.]/g, " ")} ${c.symbol ?? ""} ${c.text}`)) };
}
