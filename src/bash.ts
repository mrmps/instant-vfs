// Minimal bash-shaped runner over a gitvfs repo. Read-only.
// Supports a single pipeline of commands separated by '|'. Writes throw.
//
// Implemented: echo, ls, cat, head, tail, wc, grep, find, sort, uniq, sed.
// Intentionally absent: variables, redirections (>, <, >>), command
// substitution ($(...)), backgrounding, &&/||/;, loops, writes, network.
//
// `grep -r` (or grep with a path) delegates to the VFS's native grep so
// we never walk files one-by-one. Everything else operates on in-memory
// bytes from the DO's sqlite.

export interface BashEntry {
  path: string;
  size: number;
  lines?: number;
}

export interface BashVfsGrepResult {
  matches: Array<{ path: string; line: number; text: string }>;
  files?: string[];
  truncated: boolean;
}

export interface BashVfs {
  list(opts: { prefix?: string; glob?: string }): Promise<BashEntry[]>;
  read(path: string): Promise<Uint8Array | null>;
  kind(path: string): Promise<"file" | "dir" | null>;
  grep(opts: {
    q: string;
    glob?: string;
    caseInsensitive?: boolean;
    regex?: boolean;
    word?: boolean;
    filesOnly?: boolean;
    limit?: number;
  }): Promise<BashVfsGrepResult>;
}

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
}

const MAX_STDOUT = 1_000_000;
const MAX_STDERR = 200_000;
const DEFAULT_TIMEOUT_MS = 5_000;

// ---------- path + token helpers ----------

function normalizePath(p: string): string {
  if (!p || p === "." || p === "/") return "";
  p = p.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (parts.length > 0) parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join("/");
}

function globToRegex(g: string): RegExp {
  let r = "^";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") r += ".*";
    else if (c === "?") r += ".";
    else if (c === "[") {
      const close = g.indexOf("]", i + 1);
      if (close < 0) { r += "\\["; continue; }
      r += "[" + g.slice(i + 1, close) + "]";
      i = close;
    } else if ("\\^$.|+(){}".includes(c)) r += "\\" + c;
    else r += c;
  }
  return new RegExp(r + "$");
}

function tokenizeArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (quote === '"' && c === "\\" && i + 1 < s.length) { cur += s[++i]; continue; }
      cur += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === "\\" && i + 1 < s.length) { cur += s[++i]; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) { out.push(cur); cur = ""; started = false; }
      continue;
    }
    cur += c; started = true;
  }
  if (started) out.push(cur);
  return out;
}

function splitPipeline(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "\\" && i + 1 < s.length) { cur += c + s[++i]; continue; }
    if (c === "|") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

// ---------- commands ----------

interface Ctx { vfs: BashVfs; signal?: AbortSignal; }
type Cmd = (
  argv: string[], stdin: string, ctx: Ctx,
) => Promise<{ stdout: string; stderr?: string; exitCode: number }>;

const cmdEcho: Cmd = async (argv) => ({
  stdout: argv.join(" ") + "\n", exitCode: 0,
});

const cmdCat: Cmd = async (argv, stdin, ctx) => {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "-")) {
    return { stdout: stdin, exitCode: 0 };
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  let stderr = "";
  let exitCode = 0;
  for (const raw of argv) {
    if (raw === "-") { out += stdin; continue; }
    const p = normalizePath(raw);
    const bytes = await ctx.vfs.read(p);
    if (!bytes) {
      stderr += `cat: ${raw}: No such file or directory\n`;
      exitCode = 1;
      continue;
    }
    out += decoder.decode(bytes);
  }
  return { stdout: out, stderr, exitCode };
};

const cmdLs: Cmd = async (argv, _stdin, ctx) => {
  let long = false;
  const paths: string[] = [];
  for (const a of argv) {
    if (a === "--") continue;
    if (a.startsWith("-") && a.length > 1) {
      for (const f of a.slice(1)) {
        if (f === "l") long = true;
        else if (f === "a" || f === "A" || f === "1") {}
        else return { stdout: "", stderr: `ls: invalid option -- '${f}'\n`, exitCode: 2 };
      }
    } else paths.push(a);
  }
  if (paths.length === 0) paths.push("");

  const lines: string[] = [];
  let exitCode = 0;
  for (let idx = 0; idx < paths.length; idx++) {
    const raw = paths[idx];
    const p = normalizePath(raw);
    const kind = p === "" ? "dir" : await ctx.vfs.kind(p);

    if (kind === null) {
      lines.push(`ls: ${raw}: No such file or directory`);
      exitCode = 2;
      continue;
    }

    if (kind === "file") {
      const entry = (await ctx.vfs.list({ prefix: p }))[0];
      lines.push(long && entry ? `${entry.size}\t${p}` : p);
      continue;
    }

    const entries = await ctx.vfs.list({ prefix: p });
    const dirSet = new Set<string>();
    const fileMap = new Map<string, BashEntry>();
    const pref = p ? p + "/" : "";
    for (const e of entries) {
      if (p !== "" && !e.path.startsWith(pref)) continue;
      const rest = p === "" ? e.path : e.path.slice(pref.length);
      const slash = rest.indexOf("/");
      if (slash >= 0) dirSet.add(rest.slice(0, slash));
      else fileMap.set(rest, e);
    }
    const names = [...new Set([...dirSet, ...fileMap.keys()])].sort();
    if (paths.length > 1) lines.push(`${raw || "."}:`);
    for (const name of names) {
      if (dirSet.has(name)) lines.push(long ? `-\t${name}/` : `${name}/`);
      else {
        const e = fileMap.get(name)!;
        lines.push(long ? `${e.size}\t${name}` : name);
      }
    }
    if (paths.length > 1 && idx < paths.length - 1) lines.push("");
  }

  return { stdout: lines.join("\n") + (lines.length ? "\n" : ""), exitCode };
};

function makeHeadTail(which: "head" | "tail"): Cmd {
  return async (argv, stdin, ctx) => {
    let n = 10;
    const paths: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-n" || a === "--lines") {
        const v = argv[++i];
        const parsed = parseInt(v ?? "", 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          return { stdout: "", stderr: `${which}: invalid number of lines: '${v}'\n`, exitCode: 1 };
        }
        n = parsed;
      } else if (/^-\d+$/.test(a)) {
        n = parseInt(a.slice(1), 10);
      } else if (a.startsWith("-") && a !== "-") {
        return { stdout: "", stderr: `${which}: unknown option: ${a}\n`, exitCode: 1 };
      } else {
        paths.push(a);
      }
    }

    const decoder = new TextDecoder("utf-8", { fatal: false });
    const sources: Array<{ label: string | null; text: string }> = [];
    if (paths.length === 0) {
      sources.push({ label: null, text: stdin });
    } else {
      for (const raw of paths) {
        if (raw === "-") { sources.push({ label: raw, text: stdin }); continue; }
        const p = normalizePath(raw);
        const bytes = await ctx.vfs.read(p);
        if (!bytes) {
          return { stdout: "", stderr: `${which}: cannot open '${raw}' for reading: No such file or directory\n`, exitCode: 1 };
        }
        sources.push({ label: raw, text: decoder.decode(bytes) });
      }
    }

    const parts: string[] = [];
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const lines = src.text.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const chosen = which === "head" ? lines.slice(0, n) : lines.slice(Math.max(0, lines.length - n));
      if (sources.length > 1 && src.label) parts.push(`==> ${src.label} <==`);
      parts.push(chosen.join("\n"));
      if (sources.length > 1 && i < sources.length - 1) parts.push("");
    }
    const stdout = parts.join("\n") + (parts.length ? "\n" : "");
    return { stdout, exitCode: 0 };
  };
}

const cmdWc: Cmd = async (argv, stdin, ctx) => {
  let linesOnly = false, wordsOnly = false, charsOnly = false;
  const paths: string[] = [];
  for (const a of argv) {
    if (a.startsWith("-") && a !== "-") {
      for (const f of a.slice(1)) {
        if (f === "l") linesOnly = true;
        else if (f === "w") wordsOnly = true;
        else if (f === "c" || f === "m") charsOnly = true;
      }
    } else paths.push(a);
  }
  const selective = linesOnly || wordsOnly || charsOnly;
  const count = (s: string) => {
    const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
    const lineCount = s === "" ? 0 : trimmed.split("\n").length;
    const wordCount = s.trim() === "" ? 0 : s.trim().split(/\s+/).length;
    return { lines: lineCount, words: wordCount, chars: s.length };
  };
  const format = (c: ReturnType<typeof count>, label?: string) => {
    const fields = selective
      ? [linesOnly ? c.lines : null, wordsOnly ? c.words : null, charsOnly ? c.chars : null]
          .filter((x) => x !== null).join(" ")
      : `${c.lines} ${c.words} ${c.chars}`;
    return label ? `${fields} ${label}` : fields;
  };

  if (paths.length === 0) return { stdout: format(count(stdin)) + "\n", exitCode: 0 };

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const out: string[] = [];
  const total = { lines: 0, words: 0, chars: 0 };
  let exitCode = 0;
  for (const raw of paths) {
    if (raw === "-") {
      const c = count(stdin);
      total.lines += c.lines; total.words += c.words; total.chars += c.chars;
      out.push(format(c, "-"));
      continue;
    }
    const p = normalizePath(raw);
    const bytes = await ctx.vfs.read(p);
    if (!bytes) {
      out.push(`wc: ${raw}: No such file or directory`);
      exitCode = 1;
      continue;
    }
    const c = count(decoder.decode(bytes));
    total.lines += c.lines; total.words += c.words; total.chars += c.chars;
    out.push(format(c, raw));
  }
  if (paths.length > 1) out.push(format(total, "total"));
  return { stdout: out.join("\n") + "\n", exitCode };
};

function buildLocalGrepRegex(
  pattern: string,
  flags: { i: boolean; E: boolean; w: boolean },
): RegExp | null {
  try {
    let p = flags.E ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (flags.w) p = `\\b(?:${p})\\b`;
    return new RegExp(p, flags.i ? "i" : "");
  } catch { return null; }
}

const cmdGrep: Cmd = async (argv, stdin, ctx) => {
  const flags = { i: false, r: false, l: false, n: false, v: false, w: false, E: false };
  let pattern: string | null = null;
  const paths: string[] = [];
  for (const a of argv) {
    if (a === "--") continue;
    if (a.startsWith("-") && a.length > 1 && !/^-\d+$/.test(a)) {
      for (const f of a.slice(1)) {
        if (f in flags) (flags as any)[f] = true;
        else return { stdout: "", stderr: `grep: invalid option -- '${f}'\n`, exitCode: 2 };
      }
      continue;
    }
    if (pattern === null) pattern = a;
    else paths.push(a);
  }
  if (pattern === null) return { stdout: "", stderr: "grep: missing pattern\n", exitCode: 2 };

  // stdin mode: grep over piped text.
  if (paths.length === 0 && !flags.r) {
    if (!stdin) return { stdout: "", exitCode: 1 };
    const re = buildLocalGrepRegex(pattern, flags);
    if (!re) return { stdout: "", stderr: `grep: invalid regex\n`, exitCode: 2 };
    const lines = stdin.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    const hits: string[] = [];
    lines.forEach((L, idx) => {
      const matches = re.test(L);
      if (matches !== flags.v) hits.push(flags.n ? `${idx + 1}:${L}` : L);
    });
    return { stdout: hits.join("\n") + (hits.length ? "\n" : ""), exitCode: hits.length ? 0 : 1 };
  }

  // Recursive or path-scoped: delegate to server grep.
  const limit = 10000;
  const globs = paths.length > 0
    ? paths.map((raw) => {
        const p = normalizePath(raw);
        return p ? `${p}/**` : "**";
      })
    : ["**"];
  let allMatches: Array<{ path: string; line: number; text: string }> = [];
  let allFiles: string[] = [];
  let truncated = false;
  for (const glob of globs) {
    const r = await ctx.vfs.grep({
      q: pattern, glob,
      caseInsensitive: flags.i,
      regex: flags.E,
      word: flags.w,
      filesOnly: flags.l,
      limit,
    });
    if (flags.l) allFiles = allFiles.concat(r.files ?? []);
    else allMatches = allMatches.concat(r.matches);
    if (r.truncated) truncated = true;
  }
  if (flags.l) {
    const uniq = [...new Set(allFiles)].sort();
    return { stdout: uniq.join("\n") + (uniq.length ? "\n" : ""), exitCode: uniq.length ? 0 : 1 };
  }
  const rendered = allMatches.map((m) =>
    flags.n ? `${m.path}:${m.line}:${m.text}` : `${m.path}:${m.text}`,
  );
  return {
    stdout: rendered.join("\n") + (rendered.length ? "\n" : ""),
    exitCode: rendered.length ? 0 : 1,
    ...(truncated ? { stderr: `grep: output truncated at ${limit} matches\n` } : {}),
  };
};

const cmdFind: Cmd = async (argv, _stdin, ctx) => {
  let root = "";
  const filters: { name?: string; type?: "f" | "d" } = {};
  let rootSet = false;
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-name") { filters.name = argv[++i]; }
    else if (a === "-type") { filters.type = argv[++i] as "f" | "d"; }
    else if (!a.startsWith("-")) { if (!rootSet) { root = a; rootSet = true; } }
    else return { stdout: "", stderr: `find: unknown predicate '${a}'\n`, exitCode: 1 };
    i++;
  }
  const prefix = normalizePath(root);
  const entries = await ctx.vfs.list({ prefix });
  const dirSet = new Set<string>();
  for (const e of entries) {
    const segs = e.path.split("/");
    for (let j = 1; j < segs.length; j++) dirSet.add(segs.slice(0, j).join("/"));
  }
  const dirs = [...dirSet].sort();
  const files = entries.map((e) => e.path);

  let out: string[] = [];
  if (!filters.type || filters.type === "d") out = out.concat(dirs);
  if (!filters.type || filters.type === "f") out = out.concat(files);

  if (filters.name) {
    const re = globToRegex(filters.name);
    out = out.filter((p) => re.test(p.split("/").pop() ?? ""));
  }
  out.sort();
  return { stdout: out.join("\n") + (out.length ? "\n" : ""), exitCode: 0 };
};

const cmdSort: Cmd = async (argv, stdin) => {
  const flags = { n: false, r: false, u: false };
  for (const a of argv) {
    if (a.startsWith("-")) for (const f of a.slice(1)) (flags as any)[f] = true;
  }
  const lines = stdin.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.sort((a, b) =>
    flags.n ? (parseFloat(a) || 0) - (parseFloat(b) || 0) : a.localeCompare(b),
  );
  if (flags.r) lines.reverse();
  const final = flags.u ? [...new Set(lines)] : lines;
  return { stdout: final.join("\n") + (final.length ? "\n" : ""), exitCode: 0 };
};

const cmdUniq: Cmd = async (argv, stdin) => {
  const flags = { c: false, d: false, u: false };
  for (const a of argv) {
    if (a.startsWith("-")) for (const f of a.slice(1)) (flags as any)[f] = true;
  }
  const lines = stdin.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const count = j - i;
    if (flags.c) out.push(`${String(count).padStart(7)} ${lines[i]}`);
    else if (flags.d && count > 1) out.push(lines[i]);
    else if (flags.u && count === 1) out.push(lines[i]);
    else if (!flags.d && !flags.u) out.push(lines[i]);
    i = j;
  }
  return { stdout: out.join("\n") + (out.length ? "\n" : ""), exitCode: 0 };
};

const cmdSed: Cmd = async (argv, stdin, ctx) => {
  // v1 supports only: sed -n "A,Bp" [file]  — the "read lines A..B" idiom.
  let nFlag = false;
  let expr: string | null = null;
  let path: string | null = null;
  for (const a of argv) {
    if (a === "-n") { nFlag = true; continue; }
    if (a.startsWith("-")) return { stdout: "", stderr: `sed: unsupported flag ${a}\n`, exitCode: 2 };
    if (expr === null) expr = a;
    else if (path === null) path = a;
    else return { stdout: "", stderr: `sed: too many arguments\n`, exitCode: 2 };
  }
  if (!expr) return { stdout: "", stderr: `sed: missing expression\n`, exitCode: 2 };
  const m = expr.match(/^(\d+)(?:,(\d+|\$))?p$/);
  if (!m || !nFlag) {
    return {
      stdout: "",
      stderr: `sed: only '-n "A,Bp"' style line-range expressions are supported in v1\n`,
      exitCode: 2,
    };
  }
  let text = stdin;
  if (path !== null) {
    const p = normalizePath(path);
    const bytes = await ctx.vfs.read(p);
    if (!bytes) {
      return { stdout: "", stderr: `sed: ${path}: No such file or directory\n`, exitCode: 2 };
    }
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const start = Math.max(1, parseInt(m[1], 10));
  const end = m[2] === "$" || m[2] === undefined ? lines.length : parseInt(m[2], 10);
  const slice = lines.slice(start - 1, Math.min(lines.length, end));
  return { stdout: slice.join("\n") + (slice.length ? "\n" : ""), exitCode: 0 };
};

const COMMANDS: Record<string, Cmd> = {
  echo: cmdEcho,
  ls: cmdLs,
  cat: cmdCat,
  head: makeHeadTail("head"),
  tail: makeHeadTail("tail"),
  wc: cmdWc,
  grep: cmdGrep,
  find: cmdFind,
  sort: cmdSort,
  uniq: cmdUniq,
  sed: cmdSed,
};

export const SUPPORTED_COMMANDS = Object.keys(COMMANDS);

// ---------- runner ----------

export async function runBash(
  script: string,
  vfs: BashVfs,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<BashResult> {
  const t0 = performance.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = t0 + timeoutMs;
  const segments = splitPipeline(script);
  if (segments.length === 0) {
    return { stdout: "", stderr: "", exitCode: 0, durationMs: 0, truncated: false };
  }

  const ctx: Ctx = { vfs, ...(opts.signal ? { signal: opts.signal } : {}) };
  let buffer = "";
  let stderr = "";
  let exitCode = 0;
  let truncated = false;

  for (let i = 0; i < segments.length; i++) {
    if (performance.now() > deadline) {
      stderr += `bash: timeout after ${timeoutMs}ms\n`;
      exitCode = 124;
      break;
    }
    const argv = tokenizeArgs(segments[i]);
    if (argv.length === 0) continue;
    const name = argv[0];
    const fn = COMMANDS[name];
    if (!fn) {
      stderr += `bash: ${name}: command not found\n`;
      exitCode = 127;
      buffer = "";
      break;
    }
    try {
      const r = await fn(argv.slice(1), buffer, ctx);
      if (r.stderr) stderr += r.stderr;
      buffer = r.stdout;
      exitCode = r.exitCode;
    } catch (e: any) {
      stderr += `bash: ${name}: ${e?.message ?? String(e)}\n`;
      exitCode = 1;
      buffer = "";
      break;
    }
    if (buffer.length > MAX_STDOUT) { buffer = buffer.slice(0, MAX_STDOUT); truncated = true; }
    if (stderr.length > MAX_STDERR) { stderr = stderr.slice(0, MAX_STDERR); truncated = true; break; }
  }

  return {
    stdout: buffer,
    stderr,
    exitCode,
    durationMs: performance.now() - t0,
    truncated,
  };
}
