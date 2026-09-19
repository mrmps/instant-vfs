// Semantic layer over a repo snapshot. Everything lexical (paths, grep,
// outlines, line slices) comes from `Source`; everything that needs judgment
// goes to Jev (src/jev.ts). The worker adapts its Durable Object stub to
// `Source`; bench/semantic-try.ts adapts the public HTTP API so the same
// code can be iterated on locally.
//
// Endpoints served from here:
//   find      "where is X?" → ranked {path, symbol, line, endLine} + exists
//   rerank    grep matches ordered by how well each answers an intent
//   locate    "which lines of this file are about X?"
//   roles     one-word purpose per tree entry (entrypoint, tests, generated…)
//   verify    do these lines support this claim?

import {
  jev, jevAll, asChoice, asNoul, ranked, estTokens,
  CHOICE_MAX_OPTIONS, type Question, type JevMeter,
} from "./jev";
import { outline, detectLanguage, type OutlineItem } from "./outline";

export interface Source {
  // Every file path in the snapshot, sorted.
  paths(): Promise<string[]>;
  // One-level listing under a prefix ("" = root): files and synthesized dirs.
  level(prefix: string): Promise<Array<{ path: string; kind: "file" | "dir" }>>;
  // Decoded text of a file, or null.
  read(path: string): Promise<string | null>;
  // Literal (or regex) search, files-only or full matches.
  grep(opts: {
    q: string; regex?: boolean; caseInsensitive?: boolean; word?: boolean;
    filesOnly?: boolean; limit?: number; context?: number; glob?: string;
  }): Promise<{
    files?: string[];
    matches: Array<{ path: string; line: number; text: string; before?: string[]; after?: string[] }>;
  }>;
}

export type Ctx = { apiKey: string; meter: JevMeter };

function splitLogicalLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function round(p: number): number {
  return Math.round(p * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Query analysis (pure code): what in the question can be grepped literally?
// ---------------------------------------------------------------------------

const STOP = new Set((
  "the a an of in on at to for from with and or not is are was were be been being " +
  "this that these those it its which what where when who whom whose how why does do did " +
  "file files function functions class classes method methods define defined defines definition " +
  "declare declared declares export exported exports import imports implement implements implemented " +
  "implementation contains contain containing has have had use uses used using set sets get gets " +
  "returns return returning called call calls name named line lines path repo repository code source " +
  "main root inside under near top bottom string literal value values field fields type types " +
  "there here into onto via by as if then else than also just only any all some each every one two " +
  "exact exactly full relative answer question about find where's whats what's i we you they them their " +
  "handles handle handling logic responsible config configuration middleware component module package " +
  "directory folder dir list listing"
).split(/\s+/));

export type QueryPlan = {
  literals: string[];     // quoted strings → exact, case-sensitive grep
  identifiers: string[];  // code-shaped tokens → case-insensitive grep
  words: string[];        // remaining meaningful words (used for path hints)
};

export function planQuery(q: string): QueryPlan {
  const literals: string[] = [];
  let rest = q;
  // Quoted spans: "…", '…', `…`. Keep the longest first so nested quotes don't split.
  rest = rest.replace(/`([^`]{2,200})`|"([^"]{2,200})"|'([^']{3,200})'/g, (_m, a, b, c) => {
    const v = (a ?? b ?? c) as string;
    literals.push(v);
    return " ";
  });
  const identifiers = new Set<string>();
  const words = new Set<string>();
  for (const raw of rest.split(/[\s,;:()[\]{}<>?!]+/)) {
    const tok = raw.replace(/^[^A-Za-z0-9_$@./-]+|[^A-Za-z0-9_$]+$/g, "");
    if (!tok) continue;
    const lower = tok.toLowerCase();
    const codeShaped =
      /[a-z][A-Z]/.test(tok) ||                       // camelCase
      /^[A-Z][a-z]+[A-Z]/.test(tok) ||                // PascalCase
      /_/.test(tok) ||                                // snake_case
      /\.[a-z]{1,5}$/.test(tok) ||                    // file.ext
      /\//.test(tok) ||                               // a/path
      /^[A-Z][A-Z0-9_]{2,}$/.test(tok) ||             // CONSTANT
      /^[a-z]+[A-Z0-9][A-Za-z0-9]*$/.test(tok);
    if (codeShaped && tok.length >= 3) {
      identifiers.add(tok);
      continue;
    }
    if (STOP.has(lower) || lower.length < 4 || /^\d+$/.test(lower)) continue;
    words.add(lower);
  }
  return {
    literals: literals.filter((l) => l.trim().length >= 2),
    identifiers: [...identifiers].slice(0, 8),
    words: [...words].slice(0, 12),
  };
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

export type FindHit = {
  path: string;
  kind: "file" | "symbol" | "match";
  symbol?: string;
  symbolKind?: string;
  signature?: string;
  line?: number;
  endLine?: number;
  probability: number;
  snippet?: string;
  // Ready-to-fetch next call for this hit.
  next: string;
};

export type FindResult = {
  q: string;
  exists: number;           // P(the repo contains something that answers q)
  confidence: number;       // top hit's probability
  hits: FindHit[];
  candidates: number;
  stages: {
    paths: { total: number; considered: number; requests: number };
    grep: { literals: string[]; identifiers: string[]; files: number; error?: string };
    final: { candidates: number; deepened?: number };
  };
  // Present when read=1, or automatically when the top hit is ≥ FIND_AUTO_READ_MIN_P.
  source?: { path: string; lines: string; text: string; truncated?: boolean; next?: string };
};

type Candidate = {
  id: string;
  path: string;
  kind: "file" | "symbol" | "match";
  symbol?: string;
  symbolKind?: string;
  signature?: string;
  line?: number;
  endLine?: number;
  text?: string;
  // Why it is here (for prioritisation when trimming to 255).
  via: Set<"path" | "grep" | "both">;
};

const FIND_PATH_SINGLE_PASS = 220;   // ≤ this many files: one Choice over all paths
const FIND_BEAM_WIDTH = 4;           // dirs expanded per level
const FIND_BEAM_MIN_P = 0.06;
const FIND_BEAM_MAX_LEVELS = 8;
const FIND_PATH_KEEP = 10;           // files kept from the path stage
const FIND_PATH_HITS = 12;           // files whose path literally contains a question term
const FIND_GREP_FILES = 14;          // files kept from the grep stage
const FIND_SYMBOLS_PER_FILE = 40;
const FIND_MATCHES_PER_FILE = 3;
const FIND_DEEPEN_BELOW_P = 0.75;    // below this, read the top files line by line and judge again
const FIND_DEEPEN_FILES = 3;
const FIND_DEEPEN_MAX_LINES = 1200;
const FIND_AUTO_READ_MIN_P = 0.8;    // inline the top hit's source when this sure
const FIND_AUTO_READ_MAX_LINES = 80;

function pathInstructions(q: string): string {
  return (
    `A developer is looking for something in a source repository and asked: "${q}". ` +
    `Each option is a path in the repository (directories end with "/"). ` +
    `Pick the entry most likely to contain what they are looking for, judging only from names.`
  );
}

// Stage A: candidate files from path names alone. One Choice for small repos,
// beam search over directory levels for large ones.
async function pathStage(src: Source, ctx: Ctx, q: string): Promise<{
  files: Array<{ path: string; p: number }>; total: number; considered: number; requests: number;
}> {
  const all = await src.paths();
  const total = all.length;
  let requests = 0;
  if (total === 0) return { files: [], total, considered: 0, requests };

  if (total <= FIND_PATH_SINGLE_PASS) {
    const ids = all.map((_, i) => `p${i}`);
    const state = all.map((p, i) => `${ids[i]}| ${p}`).join("\n");
    const r = await jev(ctx.apiKey, state, {
      which: { type: "choice", instructions: pathInstructions(q), criteria: Object.fromEntries(ids.map((id) => [id, null])) },
    }, { meter: ctx.meter });
    requests++;
    const files = ranked(asChoice(r.answers.which))
      .slice(0, FIND_PATH_KEEP)
      .map(([id, p]) => ({ path: all[Number(id.slice(1))], p }));
    return { files, total, considered: total, requests };
  }

  // Beam search. Each level: one request holding every open beam's listing.
  // Listings come from the path array already in memory (no DO round trips).
  const levelOf = (prefix: string): Array<{ path: string; kind: "file" | "dir" }> => {
    const pref = prefix ? prefix + "/" : "";
    const dirs = new Set<string>();
    const files: string[] = [];
    for (const p of all) {
      if (pref && !p.startsWith(pref)) continue;
      const rest = p.slice(pref.length);
      const slash = rest.indexOf("/");
      if (slash >= 0) dirs.add(rest.slice(0, slash)); else files.push(rest);
    }
    return [
      ...[...dirs].sort().map((d) => ({ path: pref + d, kind: "dir" as const })),
      ...files.sort().map((f) => ({ path: pref + f, kind: "file" as const })),
    ];
  };
  type Beam = { prefix: string; p: number };
  let beams: Beam[] = [{ prefix: "", p: 1 }];
  const leaves: Array<{ path: string; p: number }> = [];
  let considered = 0;
  for (let level = 0; level < FIND_BEAM_MAX_LEVELS && beams.length; level++) {
    const listings = beams.map((b) => levelOf(b.prefix));
    const state: Record<string, string> = {};
    const questions: Record<string, Question> = {};
    const lookup: Array<Map<string, { path: string; kind: "file" | "dir" }>> = [];
    beams.forEach((b, bi) => {
      let entries = listings[bi];
      if (entries.length > CHOICE_MAX_OPTIONS) {
        // Extremely wide directory: prefer dirs, then files, alphabetical.
        entries = [...entries.filter((e) => e.kind === "dir"), ...entries.filter((e) => e.kind === "file")]
          .slice(0, CHOICE_MAX_OPTIONS);
      }
      const map = new Map<string, { path: string; kind: "file" | "dir" }>();
      const lines: string[] = [];
      entries.forEach((e, i) => {
        const id = `b${bi}_${i}`;
        map.set(id, e);
        lines.push(`${id}| ${e.path}${e.kind === "dir" ? "/" : ""}`);
      });
      lookup.push(map);
      considered += entries.length;
      state[`listing_${bi}`] = (b.prefix ? `contents of ${b.prefix}/\n` : "repository root\n") + lines.join("\n");
      questions[`b${bi}`] = {
        type: "choice",
        instructions: pathInstructions(q) + ` Choose from \`listing_${bi}\` only.`,
        criteria: Object.fromEntries([...map.keys()].map((id) => [id, null])),
      };
    });
    if (!Object.keys(questions).length) break;
    const r = await jev(ctx.apiKey, state, questions, { meter: ctx.meter });
    requests++;
    const nextBeams: Beam[] = [];
    beams.forEach((b, bi) => {
      const rk = ranked(asChoice(r.answers[`b${bi}`]));
      let taken = 0;
      for (const [id, p] of rk) {
        if (taken >= FIND_BEAM_WIDTH || p < FIND_BEAM_MIN_P) break;
        const e = lookup[bi].get(id);
        if (!e) continue;
        const joint = b.p * p;
        if (e.kind === "dir") nextBeams.push({ prefix: e.path, p: joint });
        else leaves.push({ path: e.path, p: joint });
        taken++;
      }
    });
    // Keep the global beam narrow: best FIND_BEAM_WIDTH+2 directories overall.
    beams = nextBeams.sort((a, b) => b.p - a.p).slice(0, FIND_BEAM_WIDTH + 2);
  }
  const files = leaves.sort((a, b) => b.p - a.p).slice(0, FIND_PATH_KEEP);
  return { files, total, considered, requests };
}

// Stage B: files that literally mention the question's code-shaped tokens.
async function grepStage(src: Source, plan: QueryPlan): Promise<{
  files: Array<{ path: string; score: number }>;
  matches: Map<string, Array<{ line: number; text: string }>>;
}> {
  const hits = new Map<string, number>();
  const matches = new Map<string, Array<{ line: number; text: string }>>();
  const record = (m: { path: string; line: number; text: string }, w: number) => {
    hits.set(m.path, (hits.get(m.path) ?? 0) + w);
    const arr = matches.get(m.path) ?? [];
    if (arr.length < FIND_MATCHES_PER_FILE && !arr.some((x) => x.line === m.line)) arr.push({ line: m.line, text: m.text });
    matches.set(m.path, arr);
  };
  const jobs: Array<Promise<void>> = [];
  for (const lit of plan.literals) {
    jobs.push(src.grep({ q: lit, limit: 60 }).then((r) => {
      const seen = new Set<string>();
      for (const m of r.matches) { record(m, seen.has(m.path) ? 0 : 3); seen.add(m.path); }
    }));
  }
  for (const ident of plan.identifiers) {
    jobs.push(src.grep({ q: ident, caseInsensitive: true, limit: 80 }).then((r) => {
      const seen = new Set<string>();
      for (const m of r.matches) {
        // Definition-shaped lines outrank mentions.
        const def = /\b(function|class|const|let|var|def|fn|type|interface|export|struct|enum|impl|func)\b/.test(m.text);
        record(m, seen.has(m.path) ? 0 : def ? 2 : 1);
        seen.add(m.path);
      }
    }));
  }
  // Plain words are a weak signal on their own (too common), but a line that
  // contains two or more of them is a real candidate: "status code when the
  // body is too large" → `status: 413` inside body-limit. Score = distinct
  // words per line; only lines with ≥2 words (or 1 when the question has
  // only one) are kept, and only when nothing code-shaped was available or
  // the word hits are concentrated.
  const words = plan.words.slice(0, 6);
  if (words.length) {
    const perLine = new Map<string, { path: string; line: number; text: string; words: Set<string> }>();
    await Promise.all(words.map((w) => src.grep({ q: w, caseInsensitive: true, limit: 150 }).then((r) => {
      for (const m of r.matches) {
        const k = `${m.path}:${m.line}`;
        const e = perLine.get(k) ?? { path: m.path, line: m.line, text: m.text, words: new Set<string>() };
        e.words.add(w);
        perLine.set(k, e);
      }
    }).catch(() => {})));
    const need = Math.min(2, words.length);
    const strong = [...perLine.values()].filter((e) => e.words.size >= need)
      .sort((a, b) => b.words.size - a.words.size).slice(0, 40);
    for (const e of strong) record({ path: e.path, line: e.line, text: e.text }, e.words.size >= 3 ? 2 : 1);
  }
  const files = [...hits.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, FIND_GREP_FILES);
  return { files, matches };
}

function flattenOutline(items: OutlineItem[], depth = 1): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const it of items) {
    out.push(it);
    if (depth > 1 && it.children) out.push(...flattenOutline(it.children, depth - 1));
  }
  return out;
}

export async function find(
  src: Source, ctx: Ctx, q: string,
  opts: { read?: boolean; limit?: number } = {},
): Promise<FindResult> {
  const plan = planQuery(q);
  let grepError: string | undefined;
  const [paths, greps] = await Promise.all([
    pathStage(src, ctx, q),
    grepStage(src, plan).catch((e: any) => {
      grepError = e?.message ?? String(e);
      return { files: [], matches: new Map<string, Array<{ line: number; text: string }>>() };
    }),
  ]);

  // Lexical path hits: any path whose segments contain a question term
  // ("body" → src/middleware/body-limit/index.ts). Cheap recall for the
  // cases where the name-only judgment ranks a plausible-sounding file
  // (http-exception.ts for "status code") over the one that has the answer.
  const terms = [...new Set([
    ...plan.words,
    ...plan.identifiers.flatMap((t) => t.split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/).map((x) => x.toLowerCase()).filter((x) => x.length >= 3)),
  ])];
  const pathHits: Array<{ path: string; score: number }> = [];
  if (terms.length) {
    const all = await src.paths();
    for (const p of all) {
      const lower = p.toLowerCase();
      const name = lower.slice(lower.lastIndexOf("/") + 1);
      let score = 0;
      for (const t of terms) if (lower.includes(t)) score += name.includes(t) ? 2 : 1;
      if (score) pathHits.push({ path: p, score });
    }
    pathHits.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  }

  // Merge candidate files, prioritising ones both stages agree on.
  const fileSet = new Map<string, Set<"path" | "grep">>();
  for (const f of paths.files) fileSet.set(f.path, new Set(["path"]));
  for (const f of pathHits.slice(0, FIND_PATH_HITS)) if (!fileSet.has(f.path)) fileSet.set(f.path, new Set(["path"]));
  for (const f of greps.files) {
    const s = fileSet.get(f.path) ?? new Set();
    s.add("grep");
    fileSet.set(f.path, s);
  }
  const orderedFiles = [...fileSet.entries()]
    .map(([path, via]) => ({ path, via, rank: (via.size === 2 ? 0 : via.has("grep") ? 1 : 2) }))
    .sort((a, b) => a.rank - b.rank);

  // Stage C: expand each file into symbol / match candidates.
  const candidates: Candidate[] = [];
  const texts = new Map<string, string>();
  await Promise.all(orderedFiles.map(async (f) => {
    const t = await src.read(f.path);
    if (t !== null) texts.set(f.path, t);
  }));
  for (const f of orderedFiles) {
    const via = new Set<"path" | "grep" | "both">(f.via.size === 2 ? ["both"] : [...f.via]);
    const text = texts.get(f.path);
    const lang = detectLanguage(f.path);
    const total = text !== undefined ? splitLogicalLines(text).length : undefined;
    candidates.push({ id: "", path: f.path, kind: "file", line: 1, endLine: total, via });
    if (text !== undefined && lang !== "text") {
      const o = outline(f.path, text, { depth: 1 });
      for (const it of flattenOutline(o.items).slice(0, FIND_SYMBOLS_PER_FILE)) {
        candidates.push({
          id: "", path: f.path, kind: "symbol", symbol: it.name, symbolKind: it.kind,
          signature: it.signature, line: it.line, endLine: it.endLine, via,
        });
      }
    }
    for (const m of greps.matches.get(f.path) ?? []) {
      // A grep hit on a symbol's own line is the same location: fold it in.
      const sym = candidates.find((c) => c.path === f.path && c.kind === "symbol" && c.line === m.line);
      if (sym) { sym.text = m.text.slice(0, 160); continue; }
      candidates.push({ id: "", path: f.path, kind: "match", line: m.line, text: m.text.slice(0, 160), via });
    }
  }
  // Trim to the Choice limit: keep every "both", then grep-backed, then path-only.
  const order = (c: Candidate) => c.via.has("both") ? 0 : c.via.has("grep") ? 1 : 2;
  const trimmed = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => order(a.c) - order(b.c) || a.i - b.i)
    .slice(0, CHOICE_MAX_OPTIONS)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.c);
  trimmed.forEach((c, i) => (c.id = `c${i}`));

  const empty: FindResult = {
    q, exists: 0, confidence: 0, hits: [], candidates: trimmed.length,
    stages: {
      paths: { total: paths.total, considered: paths.considered, requests: paths.requests },
      grep: { literals: plan.literals, identifiers: plan.identifiers, files: greps.files.length, ...(grepError ? { error: grepError } : {}) },
      final: { candidates: trimmed.length },
    },
  };
  if (!trimmed.length) return empty;
  // (deepened count is filled in below once known)

  // Final judgment: one Choice over every candidate + one Noul for existence.
  const judge = async (cands: Candidate[]) => {
    const lines = cands.map((c) => {
      if (c.kind === "file") return `${c.id}| FILE ${c.path}${c.endLine ? ` (${c.endLine} lines)` : ""}`;
      if (c.kind === "symbol") {
        return `${c.id}| ${c.symbolKind ?? "symbol"} ${c.symbol} in ${c.path}:${c.line}` +
          (c.signature ? ` — ${c.signature.slice(0, 120)}` : c.text ? ` — ${c.text.trim().slice(0, 120)}` : "");
      }
      return `${c.id}| line ${c.line} of ${c.path}: ${c.text}`;
    });
    const r = await jev(ctx.apiKey, lines.join("\n"), {
      best: {
        type: "choice",
        instructions:
          `A developer asked: "${q}". Each option is a location in a source repository: a whole file, ` +
          `a symbol (function/class/type) with its signature, or a specific line with its text. ` +
          `Pick the location that best answers the question. Prefer the definition over a usage, ` +
          `and a specific symbol or line over its whole file when it is the actual answer.`,
        criteria: Object.fromEntries(cands.map((c) => [c.id, null])),
      },
      exists: {
        type: "noul",
        instructions:
          `A developer asked: "${q}". Does at least one of the listed locations plausibly contain ` +
          `what they are looking for?`,
        criteria: {
          true: "One of the listed locations is clearly what the question is about.",
          false: "None of the listed locations relate to the question; the answer is probably elsewhere or absent.",
        },
      },
    }, { meter: ctx.meter });
    return { best: asChoice(r.answers.best), exists: asNoul(r.answers.exists) ?? 0 };
  };

  let judged = await judge(trimmed);
  let finalCands = trimmed;

  // Deepen: when the model is not sure which *location* answers, read the
  // top few files line by line and judge again with the best lines added.
  // This is what turns "what status code is returned when…" into
  // `status: 413` instead of "the file that mentions status codes".
  let deepened = 0;
  const topP = ranked(judged.best)[0]?.[1] ?? 0;
  if (topP < FIND_DEEPEN_BELOW_P && judged.exists >= 0.3) {
    const byIdTmp = new Map(trimmed.map((c) => [c.id, c]));
    const files: string[] = [];
    for (const [id] of ranked(judged.best)) {
      const c = byIdTmp.get(id);
      if (!c) continue;
      const t = texts.get(c.path);
      if (t === undefined || splitLogicalLines(t).length > FIND_DEEPEN_MAX_LINES) continue;
      if (!files.includes(c.path)) files.push(c.path);
      if (files.length >= FIND_DEEPEN_FILES) break;
    }
    const located = await Promise.all(files.map((f) => locate(ctx, f, texts.get(f)!, q, { limit: 6 }).catch(() => null)));
    const extra: Candidate[] = [];
    located.forEach((L, i) => {
      if (!L) return;
      for (const h of L.hits) {
        if (h.probability < 0.05) continue;
        if (trimmed.some((c) => c.path === files[i] && c.line === h.line && c.kind !== "file")) continue;
        extra.push({ id: "", path: files[i], kind: "match", line: h.line, text: h.text.trim().slice(0, 160), via: new Set(["grep"]) });
      }
    });
    if (extra.length) {
      deepened = extra.length;
      const room = CHOICE_MAX_OPTIONS - extra.length;
      const keep = trimmed.slice(0, Math.max(0, room));
      finalCands = [...keep, ...extra];
      finalCands.forEach((c, i) => (c.id = `c${i}`));
      judged = await judge(finalCands);
    }
  }

  const best = judged.best;
  const exists = judged.exists;
  const byId = new Map(finalCands.map((c) => [c.id, c]));
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
  const hits: FindHit[] = [];
  for (const [id, p] of ranked(best).slice(0, limit)) {
    const c = byId.get(id);
    if (!c) continue;
    const text = texts.get(c.path);
    let snippet: string | undefined;
    if (text !== undefined && c.line) {
      const ls = splitLogicalLines(text);
      const start = c.line;
      const end = Math.min(ls.length, c.kind === "match" ? c.line : Math.min(c.endLine ?? c.line + 5, c.line + 5));
      snippet = ls.slice(start - 1, end).map((L, i) => `${start + i} | ${L}`).join("\n");
    }
    const range = c.line
      ? `?lines=${c.line}-${c.endLine ?? Math.min((texts.get(c.path) ? splitLogicalLines(texts.get(c.path)!).length : c.line + 40), c.line + 40)}`
      : "";
    hits.push({
      path: c.path, kind: c.kind, symbol: c.symbol, symbolKind: c.symbolKind, signature: c.signature,
      line: c.line, endLine: c.endLine, probability: round(p), snippet,
      next: `/file/${c.path}${range}`,
    });
  }
  const result: FindResult = {
    ...empty,
    stages: { ...empty.stages, final: { candidates: finalCands.length, ...(deepened ? { deepened } : {}) } },
    exists: round(exists), confidence: round(hits[0]?.probability ?? 0), hits,
  };
  const top = hits[0];
  const autoRead = opts.read === undefined && top !== undefined && top.probability >= FIND_AUTO_READ_MIN_P;
  if ((opts.read || autoRead) && top) {
    const text = texts.get(top.path);
    if (text !== undefined) {
      const ls = splitLogicalLines(text);
      const maxLines = opts.read ? 200 : FIND_AUTO_READ_MAX_LINES;
      const start = top.line ?? 1;
      const natural = top.endLine ?? (top.kind === "match" ? start + 20 : ls.length);
      const end = Math.min(ls.length, natural, start + maxLines - 1);
      result.source = {
        path: top.path,
        lines: `${start}-${end}`,
        text: ls.slice(start - 1, end).map((L, i) => `${start + i} | ${L}`).join("\n"),
        ...(end < natural ? { truncated: true, next: `/file/${top.path}?lines=${start}-${Math.min(ls.length, natural)}` } : {}),
      };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// rerank: grep matches ordered by relevance to an intent
// ---------------------------------------------------------------------------

export const RERANK_MAX = 160;

export async function rerank<M extends { path: string; line: number; text: string; before?: string[]; after?: string[]; inSymbol?: string }>(
  ctx: Ctx, intent: string, matches: M[],
): Promise<Array<M & { relevance: number }>> {
  if (!matches.length) return [];
  const subset = matches.slice(0, RERANK_MAX);
  const state = subset.map((m, i) => {
    const ctxBefore = (m.before ?? []).map((l) => `    ${l}`).join("\n");
    const ctxAfter = (m.after ?? []).map((l) => `    ${l}`).join("\n");
    return `m${i}| ${m.path}:${m.line}${m.inSymbol ? ` (in ${m.inSymbol})` : ""}\n` +
      (ctxBefore ? ctxBefore + "\n" : "") + `>>> ${m.text}` + (ctxAfter ? "\n" + ctxAfter : "");
  }).join("\n\n");
  // Batches of ≤ 80 nouls per request keep each request small and fast.
  const BATCH = 80;
  const batches: number[][] = [];
  for (let i = 0; i < subset.length; i += BATCH) batches.push(subset.slice(i, i + BATCH).map((_, j) => i + j));
  const answers = await jevAll(batches.map((idxs) => async () => {
    const questions: Record<string, Question> = {};
    for (const i of idxs) {
      questions[`m${i}`] = {
        type: "noul",
        instructions:
          `A developer searched a repository with the intent: "${intent}". ` +
          `Does match \`m${i}\` (the line marked >>> and its context) answer or directly serve that intent?`,
        criteria: {
          true: "This line is what the developer is looking for, or the definition / decisive usage they need.",
          false: "Incidental mention, unrelated code, test fixture, comment, or a usage that does not serve the intent.",
        },
      };
    }
    const r = await jev(ctx.apiKey, state, questions, { meter: ctx.meter });
    return idxs.map((i) => asNoul(r.answers[`m${i}`]) ?? 0);
  }), 4);
  const rel = new Map<number, number>();
  batches.forEach((idxs, b) => idxs.forEach((i, j) => rel.set(i, answers[b][j])));
  return subset
    .map((m, i) => ({ ...m, relevance: round(rel.get(i) ?? 0) }))
    .sort((a, b) => b.relevance - a.relevance || a.path.localeCompare(b.path) || a.line - b.line);
}

// ---------------------------------------------------------------------------
// locate: which lines of one file are about X?
// ---------------------------------------------------------------------------

const LOCATE_WINDOW = 150;
const LOCATE_MAX_LINES = 4000;
const LOCATE_WINDOWS_PER_REQUEST = 6;

export type LocateResult = {
  path: string;
  q: string;
  totalLines: number;
  scanned: string;           // "1-4000" if capped
  exists: number;
  hits: Array<{ line: number; text: string; probability: number }>;
  slice?: { lines: string; text: string };
};

export async function locate(ctx: Ctx, path: string, text: string, q: string, opts: { context?: number; limit?: number } = {}): Promise<LocateResult> {
  const all = splitLogicalLines(text);
  const totalLines = all.length;
  const lines = all.slice(0, LOCATE_MAX_LINES);
  const windows: Array<{ start: number; end: number }> = [];
  for (let s = 0; s < lines.length; s += LOCATE_WINDOW) windows.push({ start: s + 1, end: Math.min(lines.length, s + LOCATE_WINDOW) });
  const groups: Array<Array<number>> = [];
  for (let i = 0; i < windows.length; i += LOCATE_WINDOWS_PER_REQUEST) groups.push(windows.slice(i, i + LOCATE_WINDOWS_PER_REQUEST).map((_, j) => i + j));

  const perWindow = await jevAll(groups.map((wins) => async () => {
    const state: Record<string, string> = {};
    const questions: Record<string, Question> = {};
    for (const wi of wins) {
      const w = windows[wi];
      const ids: string[] = [];
      const body: string[] = [];
      for (let L = w.start; L <= w.end; L++) {
        const id = `L${L}`;
        ids.push(id);
        body.push(`${id}| ${lines[L - 1].slice(0, 300)}`);
      }
      state[`w${wi}`] = body.join("\n");
      questions[`which_w${wi}`] = {
        type: "choice",
        instructions: `Which line of \`w${wi}\` (a slice of ${path}) best answers or is most directly about: "${q}"?`,
        criteria: Object.fromEntries(ids.map((id) => [id, null])),
      };
      questions[`exists_w${wi}`] = {
        type: "noul",
        instructions: `Does any line of \`w${wi}\` (a slice of ${path}) address: "${q}"?`,
        criteria: {
          true: "At least one line states, defines, or directly implies the answer.",
          false: "No line in this slice is about it.",
        },
      };
    }
    const r = await jev(ctx.apiKey, state, questions, { meter: ctx.meter });
    return wins.map((wi) => ({
      wi,
      exists: asNoul(r.answers[`exists_w${wi}`]) ?? 0,
      ranked: ranked(asChoice(r.answers[`which_w${wi}`])),
    }));
  }), 4);

  const flat = perWindow.flat();
  const exists = Math.max(0, ...flat.map((w) => w.exists));
  // Score a line by its window's existence probability times its within-window rank probability.
  const scored: Array<{ line: number; probability: number }> = [];
  for (const w of flat) {
    for (const [id, p] of w.ranked.slice(0, 5)) scored.push({ line: Number(id.slice(1)), probability: w.exists * p });
  }
  scored.sort((a, b) => b.probability - a.probability);
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
  const hits = scored.slice(0, limit).map((s) => ({ line: s.line, text: lines[s.line - 1], probability: round(s.probability) }));
  const out: LocateResult = {
    path, q, totalLines, scanned: `1-${lines.length}`, exists: round(exists), hits,
  };
  if (hits.length) {
    const c = Math.max(0, Math.min(opts.context ?? 3, 40));
    const start = Math.max(1, hits[0].line - c);
    const end = Math.min(totalLines, hits[0].line + c);
    out.slice = { lines: `${start}-${end}`, text: all.slice(start - 1, end).map((L, i) => `${start + i} | ${L}`).join("\n") };
  }
  return out;
}

// ---------------------------------------------------------------------------
// roles: one-word purpose per tree entry
// ---------------------------------------------------------------------------

export const ROLES: Record<string, string> = {
  entrypoint: "Where execution or exports start: main, index, app, cli, server bootstrap.",
  core: "The primary logic the project exists for.",
  api: "HTTP routes, handlers, RPC, request/response plumbing.",
  ui: "User interface: components, views, pages, styles.",
  types: "Type definitions, schemas, interfaces, protocol definitions.",
  util: "Shared helpers and small utilities.",
  config: "Configuration, environment, settings, manifests (package.json, tsconfig, wrangler.toml).",
  build: "Build, bundling, packaging, release scripts.",
  ci: "Continuous integration and automation workflows (.github, pipelines).",
  tests: "Tests, fixtures, mocks, benchmarks.",
  docs: "Documentation, READMEs, changelogs, licenses, guides.",
  examples: "Example or demo code not part of the product.",
  data: "Static data, datasets, migrations, seeds.",
  assets: "Images, fonts, icons, media, static public files.",
  generated: "Generated or vendored output that humans do not edit (lockfiles, dist, snapshots).",
  scripts: "One-off maintenance or developer scripts.",
};

export async function roles(
  ctx: Ctx, entries: Array<{ path: string; kind: "file" | "dir" }>,
): Promise<Map<string, { role: string; confidence: number }>> {
  const out = new Map<string, { role: string; confidence: number }>();
  if (!entries.length) return out;
  const subset = entries.slice(0, 400);
  const BATCH = 120;
  const batches: number[][] = [];
  for (let i = 0; i < subset.length; i += BATCH) batches.push(subset.slice(i, i + BATCH).map((_, j) => i + j));
  const criteria = Object.fromEntries(Object.entries(ROLES));
  const results = await jevAll(batches.map((idxs) => async () => {
    const state = idxs.map((i) => `e${i}| ${subset[i].path}${subset[i].kind === "dir" ? "/" : ""}`).join("\n");
    const questions: Record<string, Question> = {};
    for (const i of idxs) {
      questions[`e${i}`] = {
        type: "choice",
        instructions: `What is the purpose of repository entry \`e${i}\` (a ${subset[i].kind === "dir" ? "directory" : "file"}), judging from its path and the other entries?`,
        criteria,
      };
    }
    const r = await jev(ctx.apiKey, state, questions, { meter: ctx.meter });
    return idxs.map((i) => {
      const c = asChoice(r.answers[`e${i}`]);
      return { path: subset[i].path, role: c?.choice ?? "unknown", confidence: round(c?.confidence ?? 0) };
    });
  }), 4);
  for (const batch of results) for (const r of batch) out.set(r.path, { role: r.role, confidence: r.confidence });
  return out;
}

// ---------------------------------------------------------------------------
// verify: do these lines support this claim?
// ---------------------------------------------------------------------------

export type VerifyResult = {
  path: string;
  lines: string;
  claim: string;
  supported: number;
  verdict: "supported" | "contradicted" | "unrelated";
  confidence: number;
  probabilities: Record<string, number>;
};

export async function verify(ctx: Ctx, path: string, range: string, text: string, claim: string): Promise<VerifyResult> {
  const numbered = splitLogicalLines(text);
  const start = Number(range.split("-")[0]) || 1;
  const state = { path, lines: range, source: numbered.map((L, i) => `${start + i} | ${L}`).join("\n"), claim };
  const r = await jev(ctx.apiKey, state, {
    supported: {
      type: "noul",
      instructions: "Do the quoted `source` lines from `path` support the `claim` as stated?",
      criteria: {
        true: "The source states or directly implies the claim; details such as names, values, and line references match.",
        false: "The source does not establish the claim, contradicts it, or the claim gets a detail wrong.",
      },
    },
    verdict: {
      type: "choice",
      instructions: "How does the `source` relate to the `claim`?",
      criteria: {
        supported: "The source establishes the claim.",
        contradicted: "The source shows the claim is wrong in at least one detail.",
        unrelated: "The source does not speak to the claim either way.",
      },
    },
  }, { meter: ctx.meter });
  const c = asChoice(r.answers.verdict);
  return {
    path, lines: range, claim,
    supported: round(asNoul(r.answers.supported) ?? 0),
    verdict: (c?.choice as VerifyResult["verdict"]) ?? "unrelated",
    confidence: round(c?.confidence ?? 0),
    probabilities: Object.fromEntries(Object.entries(c?.probabilities ?? {}).map(([k, v]) => [k, round(v)])),
  };
}

// ---------------------------------------------------------------------------
// intent recovery: an unknown query param → which known one did they mean?
// ---------------------------------------------------------------------------

export async function meantParam(ctx: Ctx, endpoint: string, given: string, known: string[]): Promise<{ param: string | null; confidence: number }> {
  const r = await jev(ctx.apiKey, { endpoint, given_param: given, known_params: known }, {
    meant: {
      type: "choice",
      instructions: "An HTTP client sent `given_param` to `endpoint`, which only accepts `known_params`. Which known param did they most likely mean?",
      criteria: { ...Object.fromEntries(known.map((k) => [k, null])), none: "No known param has the same meaning." },
    },
  }, { meter: ctx.meter });
  const c = asChoice(r.answers.meant);
  return { param: c && c.choice !== "none" ? c.choice : null, confidence: round(c?.confidence ?? 0) };
}

export function budgetOk(state: string, questions: number): boolean {
  return estTokens(state) + questions * 40 < 30_000;
}
