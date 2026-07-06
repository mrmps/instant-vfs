export async function resolveRef(
  owner: string,
  repo: string,
  ref: string,
  token?: string,
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${ref}`;
  const base: Record<string, string> = {
    "User-Agent": "gitvfs/0.1",
    Accept: "application/vnd.github+json",
  };
  const auth = token
    ? { ...base, Authorization: `Bearer ${token}` }
    : base;
  let res = await fetch(url, { headers: auth });
  // An expired/invalid token returns 401. Rather than take the whole
  // service down, fall back to an unauthenticated request — public repos
  // still resolve (at GitHub's 60/hr anon limit). With no token there is
  // nothing to retry.
  if (res.status === 401 && token) {
    res = await fetch(url, { headers: base });
  }
  if (!res.ok) throw new Error(`resolveRef ${owner}/${repo}@${ref}: ${res.status}`);
  const j = (await res.json()) as { sha: string };
  return j.sha;
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const SHORT_SHA_RE = /^[0-9a-f]{7,39}$/i;
export function isFullSha(s: string): boolean {
  return FULL_SHA_RE.test(s);
}
export function isShortSha(s: string): boolean {
  return SHORT_SHA_RE.test(s);
}
// Accepts full SHA only. Short SHAs must be resolved via GitHub.
export function isSha(s: string): boolean {
  return FULL_SHA_RE.test(s);
}

// Heuristic: looks like a semver-ish tag that's usually immutable.
const TAG_LIKE_RE = /^v?\d+(\.\d+)*(-[0-9a-z.-]+)?$/i;
export function looksLikeTag(s: string): boolean {
  return TAG_LIKE_RE.test(s);
}
