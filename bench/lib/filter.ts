const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "vendor",
  "third_party",
  "out",
  "target",
  ".next",
  ".cache",
  ".yarn",
  "coverage",
  "__snapshots__",
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
]);

const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "bmp", "tiff",
  "mp3", "mp4", "mov", "avi", "webm", "ogg", "wav", "flac",
  "zip", "tar", "gz", "bz2", "7z", "rar", "xz",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "woff", "woff2", "ttf", "otf", "eot",
  "wasm", "so", "dylib", "dll", "a", "lib", "o",
  "class", "jar", "pyc", "pyo",
  "exe", "bin",
]);

export interface FilterOptions {
  maxFileBytes?: number;
}

export function shouldSkip(path: string, size: number, opts: FilterOptions = {}): string | null {
  const maxBytes = opts.maxFileBytes ?? 500 * 1024;
  const parts = path.split("/");
  for (const p of parts) {
    if (SKIP_DIRS.has(p)) return "skip-dir";
  }
  const base = parts[parts.length - 1];
  if (SKIP_FILES.has(base)) return "skip-file";
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx > 0) {
    const ext = base.slice(dotIdx + 1).toLowerCase();
    if (BINARY_EXT.has(ext)) return "skip-binary";
  }
  if (size > maxBytes) return "skip-size";
  return null;
}
