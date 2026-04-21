const MIME: Record<string, string> = {
  ts: "application/typescript",
  tsx: "application/typescript",
  js: "application/javascript",
  jsx: "application/javascript",
  mjs: "application/javascript",
  cjs: "application/javascript",
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  scss: "text/x-scss",
  sass: "text/x-sass",
  less: "text/x-less",
  py: "text/x-python",
  rb: "text/x-ruby",
  go: "text/x-go",
  rs: "text/x-rust",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  hpp: "text/x-c++",
  cc: "text/x-c++",
  java: "text/x-java",
  kt: "text/x-kotlin",
  swift: "text/x-swift",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  zsh: "text/x-shellscript",
  sql: "application/sql",
  graphql: "application/graphql",
  gql: "application/graphql",
  vue: "text/x-vue",
  svelte: "text/x-svelte",
  proto: "text/x-protobuf",
  lock: "text/plain",
};

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", ".git", "vendor", "third_party",
  "out", "target", ".next", ".cache", ".yarn", "coverage",
  "__pycache__", ".gradle", ".idea", ".vscode",
]);

const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "Cargo.lock", "Gemfile.lock", "poetry.lock", "composer.lock",
]);

const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "tiff",
  "mp3", "mp4", "mov", "avi", "webm", "ogg", "wav", "flac",
  "zip", "tar", "gz", "bz2", "7z", "rar", "xz", "tgz",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "woff", "woff2", "ttf", "otf", "eot",
  "wasm", "so", "dylib", "dll", "a", "lib", "o",
  "class", "jar", "pyc", "pyo",
  "exe", "bin", "dmg", "iso",
]);

export function mimeFor(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return MIME[ext] ?? "text/plain";
}

export function shouldSkip(path: string, size: number, maxBytes = 1_000_000): string | null {
  const parts = path.split("/");
  for (const p of parts) if (SKIP_DIRS.has(p)) return "skip-dir";
  const base = parts[parts.length - 1];
  if (SKIP_FILES.has(base)) return "skip-file";
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    const ext = base.slice(dot + 1).toLowerCase();
    if (BINARY_EXT.has(ext)) return "skip-binary";
  }
  if (size > maxBytes) return "skip-size";
  return null;
}
