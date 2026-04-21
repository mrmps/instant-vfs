// Translate bash-style globs to SQLite GLOB semantics.
//
// In SQLite GLOB, `*` already matches any sequence of characters including `/`.
// That means `*.md` already matches `README.md` AND `a/b.md`. But bash-style
// `**/*.md` becomes `*/*.md` in SQL GLOB, which requires at least one `/` and
// so misses root-level files.
//
// Rules:
//   - Leading "**/"  → ""           (directory segment is optional)
//   - Mid "/**/"     → "/"           (zero or more dirs → optional)
//   - Trailing "/**" → "/*"          (anything under)
//   - Remaining "**" → "*"
//
// Examples (bash → SQLite):
//   **/*.md        → *.md          (all .md anywhere)
//   src/**/*.ts    → src/*.ts      (src/foo.ts, src/a/b.ts)
//   docs/**        → docs/*        (descendants of docs/)
//   a/**/b/**/c    → a/b/c         (matches with any depth between)
export function normalizeGlob(g: string): string {
  if (!g) return g;
  let r = g;
  // Leading **/ → ""
  r = r.replace(/^\*\*\//, "");
  // Middle /**/ → "/"
  r = r.replace(/\/\*\*\//g, "/");
  // Trailing /** → "/*"
  r = r.replace(/\/\*\*$/g, "/*");
  // Remaining ** (rare) → "*"
  r = r.replace(/\*\*/g, "*");
  // Tidy doubled slashes produced by the replacements.
  r = r.replace(/\/\//g, "/");
  return r;
}
