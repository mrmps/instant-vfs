// Edge-cached ref→SHA resolution.
//
// Design: instead of re-asking GitHub "what's `main`?" every 60s, we cache the
// mapping for 24h and EXPOSE THE RESOLVED-AT TIMESTAMP TO THE AGENT. The agent
// decides whether the age is acceptable; if not it passes ?refresh=1.
//
// Cache key is a synthetic URL under a non-routable host so it doesn't collide
// with any real request URLs.

import { resolveRef as resolveRefDirect } from "./github";

const REF_TTL_SECONDS = 24 * 60 * 60; // 24h

export interface ResolvedRef {
  sha: string;
  resolvedAt: string; // ISO-8601
  ageSeconds: number;
  fromCache: boolean; // true = edge-cached ref→SHA, false = fresh GitHub call
}

function cacheKey(owner: string, repo: string, ref: string): Request {
  return new Request(
    `https://_internal.gitvfs/ref/${owner}/${repo}/${encodeURIComponent(ref)}`,
    { method: "GET" },
  );
}

export async function resolveRefCached(
  ctx: ExecutionContext,
  owner: string,
  repo: string,
  ref: string,
  token: string | undefined,
  opts: { forceRefresh?: boolean } = {},
): Promise<ResolvedRef> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = cacheKey(owner, repo, ref);

  if (!opts.forceRefresh) {
    const hit = await cache.match(key);
    if (hit) {
      try {
        const data = (await hit.json()) as { sha: string; resolvedAt: string };
        const ageSeconds = Math.max(
          0,
          Math.floor((Date.now() - new Date(data.resolvedAt).getTime()) / 1000),
        );
        return { sha: data.sha, resolvedAt: data.resolvedAt, ageSeconds, fromCache: true };
      } catch {
        // Fall through — treat as miss.
      }
    }
  }

  const sha = await resolveRefDirect(owner, repo, ref, token);
  const resolvedAt = new Date().toISOString();
  const body = JSON.stringify({ sha, resolvedAt });
  const toCache = new Response(body, {
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${REF_TTL_SECONDS}`,
    },
  });
  ctx.waitUntil(cache.put(key, toCache));
  return { sha, resolvedAt, ageSeconds: 0, fromCache: false };
}
