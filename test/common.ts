export const BASE = process.env.GITVFS_BASE ?? "https://gitvfs.miryaboy.workers.dev";
// Unique per test run so edge cache doesn't serve stale results from prior deploys.
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
let bustCounter = 0;

function appendBust(path: string, bust: boolean): string {
  if (!bust) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}_cb=${RUN_ID}-${++bustCounter}`;
}

// If the internal bypass key is present in env (matches the deployed secret),
// include it as a header so this test run isn't rate-limited by prod.
const INTERNAL_KEY = process.env.GITVFS_INTERNAL_KEY;

function withBypassHeader(init: RequestInit): RequestInit {
  if (!INTERNAL_KEY) return init;
  const headers = new Headers(init.headers ?? {});
  headers.set("x-gitvfs-key", INTERNAL_KEY);
  return { ...init, headers };
}

export async function getRaw(
  path: string,
  init: RequestInit = {},
  opts: { bust?: boolean } = { bust: true },
): Promise<Response> {
  const url = `${BASE}${appendBust(path, opts.bust ?? true)}`;
  return fetch(url, withBypassHeader(init));
}

export async function getJson<T = any>(path: string, opts: { bust?: boolean } = {}): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await getRaw(path, {}, { bust: opts.bust ?? true });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

export async function getText(path: string, opts: { bust?: boolean } = {}): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await getRaw(path, {}, { bust: opts.bust ?? true });
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

export async function head(path: string, opts: { bust?: boolean } = {}): Promise<Response> {
  return fetch(
    `${BASE}${appendBust(path, opts.bust ?? true)}`,
    withBypassHeader({ method: "HEAD" }),
  );
}

// Prewarm a repo so warm-path tests don't pay the cold-ingest wall.
export async function prewarm(ownerRepo: string): Promise<void> {
  await getRaw(`/${ownerRepo}/tree`);
}

export function approxTokens(text: string): number {
  // rough heuristic: 4 chars per token
  return Math.ceil(text.length / 4);
}
