// Lightweight code outline: extract exports / top-level symbols without a real parser.
// The goal is "roughly right" — enough for an agent to pick the right file/symbol
// without reading the full content. Catches ~90% of JS/TS/Python/Go/Rust idioms.
//
// Outputs:
//   · items with `line` (1-indexed start) and, when detectable, `endLine`
//   · leading docstrings / JSDoc / comments when `comments: true`
//   · class/interface members when `depth >= 2`
// Design goal: regex-only, dependency-free, deterministic, CPU-cheap.

export interface OutlineItem {
  kind:
    | "export" | "function" | "class" | "interface" | "type" | "enum"
    | "const" | "var" | "let" | "method" | "property";
  name: string;
  line: number;
  endLine?: number;
  signature?: string;
  leadingComment?: string;
  children?: OutlineItem[];
}

export interface Outline {
  path: string;
  language: string;
  totalLines: number;
  items: OutlineItem[];
  imports: string[];
}

export interface OutlineOptions {
  // 1 (default): top-level items only.
  // 2+: also enumerate class/interface members for TS/JS/Python.
  depth?: number;
  // When true, populate `leadingComment` on each item from the preceding
  // contiguous comment block (JSDoc, `//`, `#`, `/* ... */`).
  comments?: boolean;
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  vue: "vue",
  svelte: "svelte",
  c: "c", h: "c",
  cc: "cpp", cxx: "cpp", cpp: "cpp", "c++": "cpp",
  hh: "cpp", hpp: "cpp", hxx: "cpp", "h++": "cpp",
  m: "objc", mm: "objc",
  cs: "csharp",
  scala: "scala",
  zig: "zig",
};

export function detectLanguage(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot > 0 ? path.slice(dot + 1).toLowerCase() : "";
  return LANG_BY_EXT[ext] ?? "text";
}

type CommentFamily = "c" | "hash" | "none";

function commentFamilyFor(lang: string): CommentFamily {
  switch (lang) {
    case "typescript": case "javascript": case "go": case "rust":
    case "java": case "kotlin": case "swift": case "vue": case "svelte":
    case "php":
      return "c";
    case "python": case "ruby":
      return "hash";
    default:
      return "none";
  }
}

// ---------- brace / indent scanners for endLine ----------

// Find the line (1-indexed) that closes the brace-delimited body that *starts*
// at or after `startLine`. Tracks strings and both comment styles so braces
// inside them don't count. Returns undefined if no balanced body is found.
function endLineBraced(lines: string[], startLine: number): number | undefined {
  let i = startLine - 1;
  while (i < lines.length && lines[i].indexOf("{") < 0) i++;
  if (i >= lines.length) return undefined;
  let depth = 0;
  let inBlock = false;
  let inString: '"' | "'" | "`" | null = null;
  let stringEscape = false;
  for (; i < lines.length; i++) {
    const L = lines[i];
    let inLine = false;
    for (let j = 0; j < L.length; j++) {
      const c = L[j];
      const n = L[j + 1];
      if (inLine) continue;
      if (inBlock) {
        if (c === "*" && n === "/") { inBlock = false; j++; }
        continue;
      }
      if (inString) {
        if (stringEscape) { stringEscape = false; continue; }
        if (inString !== "`" && c === "\\") { stringEscape = true; continue; }
        if (c === inString) inString = null;
        continue;
      }
      if (c === "/" && n === "/") { inLine = true; continue; }
      if (c === "/" && n === "*") { inBlock = true; j++; continue; }
      if (c === '"' || c === "'" || c === "`") { inString = c as any; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
  }
  return undefined;
}

// Python-style: the block extends while subsequent non-blank lines are
// indented deeper than the header. `startLine` is 1-indexed.
function endLineIndented(lines: string[], startLine: number): number | undefined {
  const idx = startLine - 1;
  if (idx >= lines.length) return undefined;
  const headerIndent = leadingWs(lines[idx]);
  let last = idx;
  for (let i = idx + 1; i < lines.length; i++) {
    const L = lines[i];
    if (L.trim() === "") continue;
    if (leadingWs(L) <= headerIndent) return last + 1;
    last = i;
  }
  return last + 1;
}

function leadingWs(s: string): number {
  let n = 0;
  while (n < s.length && (s[n] === " " || s[n] === "\t")) n++;
  return n;
}

// ---------- leading comment extraction ----------

// Walk backward from the line above `itemLine` (1-indexed) and collect a
// contiguous comment block. Stops at the first non-comment, non-blank line.
// One blank line between comment and item is tolerated (common in Go / Java).
function leadingCommentFor(lines: string[], itemLine: number, family: CommentFamily): string | undefined {
  if (family === "none") return undefined;
  let i = itemLine - 2; // skip item line itself (1-indexed -> 0-indexed -> one above)
  // Allow a single blank line between the comment and the item.
  if (i >= 0 && lines[i].trim() === "") i--;

  const out: string[] = [];
  while (i >= 0) {
    const raw = lines[i];
    const t = raw.trim();
    if (t === "") break;

    if (family === "hash") {
      if (!t.startsWith("#")) break;
      out.unshift(t.replace(/^#+\s?/, ""));
      i--;
      continue;
    }

    // c-style: // line comment or /* ... */ block.
    if (t.startsWith("//")) {
      out.unshift(t.replace(/^\/\/+\s?/, ""));
      i--;
      continue;
    }
    if (t.endsWith("*/")) {
      // Collect lines up to the matching /* (may be single-line).
      const pieces: string[] = [];
      let j = i;
      while (j >= 0) {
        const LJ = lines[j].trim();
        pieces.unshift(LJ);
        if (LJ.startsWith("/*") || LJ.startsWith("/**")) break;
        j--;
      }
      if (j < 0) break;
      const joined = pieces.join("\n")
        .replace(/^\/\*+/, "")
        .replace(/\*+\/$/, "")
        .split("\n")
        .map((l) => l.trim().replace(/^\*+\s?/, ""))
        .join("\n")
        .trim();
      if (joined) out.unshift(joined);
      i = j - 1;
      continue;
    }
    break;
  }
  const joined = out.join("\n").trim();
  return joined.length > 0 ? joined : undefined;
}

// ---------- class/interface member enumeration ----------

// Loose regexes. Skip lines inside nested blocks to avoid picking up
// methods on inner objects. "Inside class body" = depth==1 w.r.t. the class.
function enumerateTsClassMembers(lines: string[], startLine: number, endLine: number): OutlineItem[] {
  const out: OutlineItem[] = [];
  let depth = 0;
  let inBlock = false;
  let inString: '"' | "'" | "`" | null = null;
  let stringEscape = false;

  // skip until the opening {
  let i = startLine - 1;
  while (i < lines.length && lines[i].indexOf("{") < 0) i++;
  if (i >= lines.length) return out;

  for (; i < endLine && i < lines.length; i++) {
    const L = lines[i];
    const trimmed = L.trim();
    const atDepthOne = depth === 1 && !inBlock && !inString;

    // Advance state over this line first (so we know "are we currently at depth 1 between members").
    const depthBefore = depth;
    for (let j = 0; j < L.length; j++) {
      const c = L[j];
      const n = L[j + 1];
      if (inBlock) {
        if (c === "*" && n === "/") { inBlock = false; j++; }
        continue;
      }
      if (inString) {
        if (stringEscape) { stringEscape = false; continue; }
        if (inString !== "`" && c === "\\") { stringEscape = true; continue; }
        if (c === inString) inString = null;
        continue;
      }
      if (c === "/" && n === "/") break; // line-comment: skip rest
      if (c === "/" && n === "*") { inBlock = true; j++; continue; }
      if (c === '"' || c === "'" || c === "`") { inString = c as any; continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }

    // Match at line-entry depth (we want the declaration line itself, which
    // is at depth 1 — inside the class body but not inside a method body).
    if (depthBefore !== 1 || inBlock || inString) continue;
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    // method:  [mods] name(<generics>)? ( ... ) [: type] {
    const mMethod = trimmed.match(
      /^(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|abstract\s+|override\s+|declare\s+)*(?:\*\s*|get\s+|set\s+)?(#?[a-zA-Z_$][\w$]*)\s*[(<]/,
    );
    if (mMethod) {
      const name = mMethod[1];
      if (name === "constructor" || !/^(if|while|for|switch|return|throw|new|await|typeof|void|delete)$/.test(name)) {
        const item: OutlineItem = {
          kind: "method", name, line: i + 1,
          signature: trimmed.slice(0, 200),
        };
        const eSearch = endLineBraced(lines, i + 1);
        if (eSearch !== undefined) item.endLine = eSearch;
        out.push(item);
        continue;
      }
    }
    // property: [mods] name[?]: type [= default]
    const mProp = trimmed.match(
      /^(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|abstract\s+|declare\s+)*(#?[a-zA-Z_$][\w$]*)[?!]?\s*[:=]/,
    );
    if (mProp) {
      out.push({
        kind: "property", name: mProp[1], line: i + 1,
        signature: trimmed.slice(0, 200),
      });
    }
  }
  return out;
}

function enumeratePyClassMembers(lines: string[], startLine: number, endLine: number): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (let i = startLine - 1; i < Math.min(endLine, lines.length); i++) {
    const L = lines[i];
    const m = L.match(/^(\s+)(?:async\s+)?def\s+(\w+)/);
    if (!m) continue;
    const item: OutlineItem = {
      kind: "method", name: m[2], line: i + 1,
      signature: L.trim().slice(0, 200),
    };
    const e = endLineIndented(lines, i + 1);
    if (e !== undefined) item.endLine = e;
    out.push(item);
  }
  return out;
}

// ---------- the outline itself ----------

export function outline(path: string, content: string, opts: OutlineOptions = {}): Outline {
  const lang = detectLanguage(path);
  const depth = Math.max(1, opts.depth ?? 1);
  const wantComments = opts.comments === true;
  const commentFamily = commentFamilyFor(lang);

  const lines = content.split("\n");
  const totalLines = lines.length;
  const items: OutlineItem[] = [];
  const imports: string[] = [];

  const push = (item: OutlineItem) => {
    if (wantComments) {
      const c = leadingCommentFor(lines, item.line, commentFamily);
      if (c) item.leadingComment = c;
    }
    items.push(item);
  };

  if (lang === "typescript" || lang === "javascript" || lang === "vue" || lang === "svelte") {
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const imp = L.match(/^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/)
        || L.match(/^\s*import\s+['"]([^'"]+)['"]/)
        || L.match(/^\s*(?:const|let|var)\s+\w[\w\s,{}*]*\s*=\s*require\(['"]([^'"]+)['"]\)/);
      if (imp) imports.push(imp[1]);

      let m: RegExpMatchArray | null;
      m = L.match(/^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/);
      if (m) {
        const item: OutlineItem = {
          kind: "function", name: m[1], line: i + 1,
          signature: L.trim().slice(0, 200),
        };
        const e = endLineBraced(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        push(item);
        continue;
      }
      m = L.match(/^\s*export\s+(?:abstract\s+)?class\s+(\w+)/);
      if (m) {
        const item: OutlineItem = {
          kind: "class", name: m[1], line: i + 1,
          signature: L.trim().slice(0, 200),
        };
        const e = endLineBraced(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        if (depth >= 2 && item.endLine !== undefined) {
          const kids = enumerateTsClassMembers(lines, item.line, item.endLine);
          if (wantComments) {
            for (const k of kids) {
              const c = leadingCommentFor(lines, k.line, commentFamily);
              if (c) k.leadingComment = c;
            }
          }
          if (kids.length > 0) item.children = kids;
        }
        push(item);
        continue;
      }
      m = L.match(/^\s*export\s+interface\s+(\w+)/);
      if (m) {
        const item: OutlineItem = {
          kind: "interface", name: m[1], line: i + 1,
          signature: L.trim().slice(0, 200),
        };
        const e = endLineBraced(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        if (depth >= 2 && item.endLine !== undefined) {
          const kids = enumerateTsClassMembers(lines, item.line, item.endLine);
          if (wantComments) {
            for (const k of kids) {
              const c = leadingCommentFor(lines, k.line, commentFamily);
              if (c) k.leadingComment = c;
            }
          }
          if (kids.length > 0) item.children = kids;
        }
        push(item);
        continue;
      }
      m = L.match(/^\s*export\s+type\s+(\w+)/);
      if (m) { push({ kind: "type", name: m[1], line: i + 1, signature: L.trim().slice(0, 200) }); continue; }
      m = L.match(/^\s*export\s+enum\s+(\w+)/);
      if (m) {
        const item: OutlineItem = {
          kind: "enum", name: m[1], line: i + 1,
          signature: L.trim().slice(0, 200),
        };
        const e = endLineBraced(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        push(item);
        continue;
      }
      m = L.match(/^\s*export\s+(const|let|var)\s+(\w+)/);
      if (m) { push({ kind: m[1] as "const" | "let" | "var", name: m[2], line: i + 1, signature: L.trim().slice(0, 200) }); continue; }
      m = L.match(/^\s*export\s*\{([^}]+)\}/);
      if (m) {
        for (const name of m[1].split(",")) {
          const clean = name.trim().split(/\s+as\s+/)[0].trim();
          if (clean) push({ kind: "export", name: clean, line: i + 1 });
        }
        continue;
      }
      if (i < 50 || L.match(/^(function|class|interface|type|enum|async\s+function)/)) {
        m = L.match(/^(?:async\s+)?function\s*\*?\s*(\w+)\s*\(/);
        if (m) {
          const item: OutlineItem = {
            kind: "function", name: m[1], line: i + 1,
            signature: L.trim().slice(0, 200),
          };
          const e = endLineBraced(lines, i + 1);
          if (e !== undefined) item.endLine = e;
          push(item);
          continue;
        }
        m = L.match(/^class\s+(\w+)/);
        if (m) {
          const item: OutlineItem = {
            kind: "class", name: m[1], line: i + 1,
            signature: L.trim().slice(0, 200),
          };
          const e = endLineBraced(lines, i + 1);
          if (e !== undefined) item.endLine = e;
          if (depth >= 2 && item.endLine !== undefined) {
            const kids = enumerateTsClassMembers(lines, item.line, item.endLine);
            if (kids.length > 0) item.children = kids;
          }
          push(item);
        }
      }
    }
  } else if (lang === "python") {
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const imp = L.match(/^\s*import\s+([\w.,\s]+)/) || L.match(/^\s*from\s+([\w.]+)\s+import/);
      if (imp) imports.push(imp[1].trim());
      let m = L.match(/^(async\s+)?def\s+(\w+)/);
      if (m) {
        const item: OutlineItem = {
          kind: "function", name: m[2], line: i + 1,
          signature: L.trim().slice(0, 200),
        };
        const e = endLineIndented(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        push(item);
        continue;
      }
      m = L.match(/^class\s+(\w+)/);
      if (m) {
        const item: OutlineItem = {
          kind: "class", name: m[1], line: i + 1,
          signature: L.trim().slice(0, 200),
        };
        const e = endLineIndented(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        if (depth >= 2 && item.endLine !== undefined) {
          const kids = enumeratePyClassMembers(lines, item.line, item.endLine);
          if (wantComments) {
            for (const k of kids) {
              const c = leadingCommentFor(lines, k.line, commentFamily);
              if (c) k.leadingComment = c;
            }
          }
          if (kids.length > 0) item.children = kids;
        }
        push(item);
      }
    }
  } else if (lang === "go") {
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const imp = L.match(/^\s*import\s+['"]([^'"]+)['"]/);
      if (imp) imports.push(imp[1]);
      let m = L.match(/^func\s+(?:\([^)]*\)\s+)?(\w+)/);
      if (m) {
        const item: OutlineItem = {
          kind: "function", name: m[1], line: i + 1,
          signature: L.trim().slice(0, 200),
        };
        const e = endLineBraced(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        push(item);
        continue;
      }
      m = L.match(/^type\s+(\w+)\s+(struct|interface)/);
      if (m) {
        const item: OutlineItem = {
          kind: m[2] === "struct" ? "class" : "interface", name: m[1], line: i + 1,
          signature: L.trim().slice(0, 200),
        };
        const e = endLineBraced(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        push(item);
      }
    }
  } else if (lang === "rust") {
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const imp = L.match(/^\s*use\s+([\w:]+)/);
      if (imp) imports.push(imp[1]);
      let m = L.match(/^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+(\w+)/);
      if (m) {
        const item: OutlineItem = {
          kind: "function", name: m[1], line: i + 1,
          signature: L.trim().slice(0, 200),
        };
        const e = endLineBraced(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        push(item);
        continue;
      }
      m = L.match(/^(?:pub(?:\([^)]+\))?\s+)?struct\s+(\w+)/);
      if (m) { push({ kind: "class", name: m[1], line: i + 1, signature: L.trim().slice(0, 200) }); continue; }
      m = L.match(/^(?:pub(?:\([^)]+\))?\s+)?trait\s+(\w+)/);
      if (m) {
        const item: OutlineItem = {
          kind: "interface", name: m[1], line: i + 1,
          signature: L.trim().slice(0, 200),
        };
        const e = endLineBraced(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        push(item);
        continue;
      }
      m = L.match(/^(?:pub(?:\([^)]+\))?\s+)?enum\s+(\w+)/);
      if (m) { push({ kind: "enum", name: m[1], line: i + 1, signature: L.trim().slice(0, 200) }); continue; }
    }
  } else if (
    lang === "c" || lang === "cpp" || lang === "objc" ||
    lang === "java" || lang === "kotlin" || lang === "csharp" || lang === "scala"
  ) {
    // C-family: loose declaration detection. Regex-based, so it'll miss
    // macro-heavy or heavily-templated code — good enough for headers and
    // typical public APIs, which is what agents care about most.
    const C_KEYWORDS_NOT_A_NAME = /^(if|while|for|switch|return|sizeof|typeof|static_assert|new|delete|throw|catch)$/;
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];

      // #include <foo.h> / #include "foo.h"  (C/C++/ObjC)
      let imp = L.match(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/);
      if (imp) { imports.push(imp[1]); continue; }
      // import / using  (Java, Kotlin, C#, Scala)
      imp = L.match(/^\s*(?:import|using)\s+([\w.]+)/);
      if (imp) imports.push(imp[1]);

      let m: RegExpMatchArray | null;
      // #define FOO  — treat as a const
      m = L.match(/^\s*#\s*define\s+(\w+)/);
      if (m) {
        push({ kind: "const", name: m[1], line: i + 1, signature: L.trim().slice(0, 200) });
        continue;
      }
      // typedef <stuff> Name;   (C/ObjC)
      m = L.match(/^\s*typedef\s+.*?\b(\w+)\s*;\s*$/);
      if (m && !C_KEYWORDS_NOT_A_NAME.test(m[1])) {
        push({ kind: "type", name: m[1], line: i + 1, signature: L.trim().slice(0, 200) });
        continue;
      }
      // struct Foo {   |   struct Foo;  (C/C++)
      m = L.match(/^\s*(?:typedef\s+)?struct\s+(\w+)/);
      if (m) {
        const item: OutlineItem = {
          kind: "class", name: m[1], line: i + 1,
          signature: L.trim().slice(0, 200),
        };
        const e = endLineBraced(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        push(item);
        continue;
      }
      // enum Foo {   |   enum class Foo {  (C/C++/Java/C#/Scala/Kotlin)
      m = L.match(/^\s*(?:typedef\s+)?enum(?:\s+class)?\s+(\w+)/);
      if (m) {
        const item: OutlineItem = {
          kind: "enum", name: m[1], line: i + 1,
          signature: L.trim().slice(0, 200),
        };
        const e = endLineBraced(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        push(item);
        continue;
      }
      // Classes/interfaces/traits in Java/Kotlin/C#/Scala/C++
      m = L.match(/^\s*(?:public\s+|private\s+|protected\s+|internal\s+|sealed\s+|abstract\s+|final\s+|open\s+|static\s+)*(class|interface|trait|object|record|struct|namespace)\s+(\w+)/);
      if (m && lang !== "c" && lang !== "objc") {
        const kind =
          m[1] === "interface" || m[1] === "trait" ? "interface" :
          m[1] === "enum" ? "enum" : "class";
        const item: OutlineItem = {
          kind, name: m[2], line: i + 1,
          signature: L.trim().slice(0, 200),
        };
        const e = endLineBraced(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        push(item);
        continue;
      }
      // Function declaration / definition: return-type name(
      // Very permissive — matches multi-word return types (e.g.
      // `CURL_EXTERN CURLcode curl_easy_init(` or `static inline int foo(`).
      // Rejects identifiers that are actually reserved words (for/while/etc).
      m = L.match(
        /^\s*(?:[A-Z_][A-Z0-9_]+\s+)*(?:extern\s+|static\s+|inline\s+|virtual\s+|const\s+|unsigned\s+|signed\s+|constexpr\s+|public\s+|private\s+|protected\s+|override\s+)*(?:\w+(?:::\w+)*(?:<[^>]*>)?\s*[*&]*\s+)+(\w+)\s*\(/,
      );
      if (m && !C_KEYWORDS_NOT_A_NAME.test(m[1]) && L.indexOf("=") < 0 || (m && L.indexOf("(") < L.indexOf("="))) {
        if (m) {
          const item: OutlineItem = {
            kind: "function", name: m[1], line: i + 1,
            signature: L.trim().slice(0, 200),
          };
          const e = endLineBraced(lines, i + 1);
          if (e !== undefined) item.endLine = e;
          push(item);
        }
      }
    }
  } else if (lang === "swift") {
    // Swift — fn/class/struct/enum/protocol. Simple and stable.
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      const imp = L.match(/^\s*import\s+([\w.]+)/);
      if (imp) imports.push(imp[1]);
      let m = L.match(/^\s*(?:public\s+|private\s+|internal\s+|open\s+|fileprivate\s+|static\s+|class\s+|final\s+|@\w+\s+)*func\s+(\w+)/);
      if (m) {
        const item: OutlineItem = { kind: "function", name: m[1], line: i + 1, signature: L.trim().slice(0, 200) };
        const e = endLineBraced(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        push(item);
        continue;
      }
      m = L.match(/^\s*(?:public\s+|open\s+|final\s+)*(class|struct|enum|protocol|actor)\s+(\w+)/);
      if (m) {
        const kind = m[1] === "protocol" ? "interface" : m[1] === "enum" ? "enum" : "class";
        const item: OutlineItem = { kind, name: m[2], line: i + 1, signature: L.trim().slice(0, 200) };
        const e = endLineBraced(lines, i + 1);
        if (e !== undefined) item.endLine = e;
        push(item);
      }
    }
  }

  const uniqImports = [...new Set(imports)].slice(0, 200);
  return { path, language: lang, totalLines, items, imports: uniqImports };
}
