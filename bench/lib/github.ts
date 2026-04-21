const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error("GITHUB_TOKEN not set");

export const RateLimit = {
  remaining: Infinity,
  reset: 0,
  callsThisRun: 0,
};

export function resetRunCounter() {
  RateLimit.callsThisRun = 0;
}

export async function gh(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "gitvfs-bench/0.0.1",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
  const rem = res.headers.get("x-ratelimit-remaining");
  const rst = res.headers.get("x-ratelimit-reset");
  if (rem) RateLimit.remaining = Number(rem);
  if (rst) RateLimit.reset = Number(rst);
  RateLimit.callsThisRun++;
  return res;
}

export async function resolveSha(owner: string, repo: string, ref = "HEAD"): Promise<string> {
  const r = await gh(`https://api.github.com/repos/${owner}/${repo}/commits/${ref}`);
  if (!r.ok) throw new Error(`resolveSha ${owner}/${repo}@${ref}: ${r.status}`);
  const j = (await r.json()) as { sha: string };
  return j.sha;
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
  url: string;
}

export async function getTree(
  owner: string,
  repo: string,
  sha: string,
): Promise<{ truncated: boolean; entries: TreeEntry[] }> {
  const r = await gh(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
  );
  if (!r.ok) throw new Error(`getTree ${owner}/${repo}@${sha}: ${r.status}`);
  const j = (await r.json()) as { truncated: boolean; tree: TreeEntry[] };
  return { truncated: j.truncated, entries: j.tree };
}

