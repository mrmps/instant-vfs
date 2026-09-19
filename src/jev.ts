// TypeSafe's Jev: a decision model, not a language model. It takes a `state`
// (string or JSON) and a map of typed questions, and returns a calibrated
// probability per option in ~150ms. gitvfs uses it wherever an agent used to
// need judgment instead of data: "which file is this about?", "which grep hit
// actually answers the question?", "which line of this file?".
//
// Contract (docs.typesafe.ai/api):
//   choice → { choice, confidence, probabilities }   (probabilities sum to 1)
//   noul   → { noul }                                (independent P(yes))
//   score  → { score, ... }
//
// Limits from the model card: 64k tokens per request, 32k for state plus the
// longest question; a Choice accepts up to 255 options. Callers here size
// their candidate sets to those limits before asking.

const API = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

export const CHOICE_MAX_OPTIONS = 255;

export type Choice = {
  type: "choice";
  instructions: string | object;
  criteria: Record<string, string | null>;
};
export type Noul = {
  type: "noul";
  instructions: string | object;
  criteria?: { true?: string; false?: string };
};
export type Score = {
  type: "score";
  instructions: string | object;
  criteria: string[];
};
export type Question = Choice | Noul | Score;

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
export type NoulAnswer = { type: "noul"; noul: number };
export type ScoreAnswer = { type: "score"; score: number; probabilities?: number[] };
export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export type JevResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export class JevError extends Error {
  constructor(message: string, public status: number, public detail?: unknown) {
    super(message);
  }
}

// Per-request accounting so responses can carry x-gitvfs-jev-* headers and
// the access log can show what semantic work cost.
export class JevMeter {
  requests = 0;
  inputTokens = 0;
  outputTokens = 0;
  ms = 0;
  model = "";
  headers(): Record<string, string> {
    return {
      "x-gitvfs-jev-requests": String(this.requests),
      "x-gitvfs-jev-tokens": String(this.inputTokens + this.outputTokens),
      "x-gitvfs-jev-ms": String(Math.round(this.ms)),
      ...(this.model ? { "x-gitvfs-jev-model": this.model } : {}),
    };
  }
}

// Rough token estimate for budgeting state size. Source code and paths run
// ~3.3 chars/token; we under-estimate on purpose so callers stay inside
// the documented limits.
export function estTokens(s: string): number {
  return Math.ceil(s.length / 3.2) + 1;
}

export async function jev(
  apiKey: string,
  state: unknown,
  questions: Record<string, Question>,
  opts: { meter?: JevMeter; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<JevResponse> {
  const body = JSON.stringify({ state, model: MODEL, questions });
  const t0 = Date.now();
  let last: JevError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 20_000);
    if (opts.signal) opts.signal.addEventListener("abort", () => ac.abort(), { once: true });
    let res: Response;
    try {
      res = await fetch(API, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body,
        signal: ac.signal,
      });
    } catch (e: any) {
      clearTimeout(timer);
      last = new JevError(`typesafe fetch failed: ${e?.message ?? String(e)}`, 0);
      await backoff(attempt);
      continue;
    }
    clearTimeout(timer);
    const payload = (await res.json().catch(() => ({}))) as Partial<JevResponse> & { detail?: unknown };
    if (res.ok && payload.answers) {
      if (opts.meter) {
        opts.meter.requests++;
        opts.meter.inputTokens += payload.usage?.input_tokens ?? 0;
        opts.meter.outputTokens += payload.usage?.output_tokens ?? 0;
        opts.meter.ms += Date.now() - t0;
        opts.meter.model = payload.model ?? opts.meter.model;
      }
      return payload as JevResponse;
    }
    last = new JevError(
      `typesafe ${res.status}: ${JSON.stringify(payload.detail ?? payload).slice(0, 300)}`,
      res.status,
      payload.detail ?? payload,
    );
    // 429 and 529 are the documented back-off statuses; 4xx otherwise is ours.
    if (res.status !== 429 && res.status !== 529 && res.status < 500) break;
    await backoff(attempt);
  }
  throw last ?? new JevError("typesafe: unknown failure", 0);
}

function backoff(attempt: number): Promise<void> {
  return new Promise((r) => setTimeout(r, 250 * 2 ** attempt + Math.random() * 150));
}

// Run several independent requests with bounded concurrency, preserving order.
export async function jevAll<T>(
  jobs: Array<() => Promise<T>>,
  concurrency = 6,
): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

export function asChoice(a: Answer | undefined): ChoiceAnswer | null {
  return a && a.type === "choice" ? a : null;
}
export function asNoul(a: Answer | undefined): number | null {
  return a && a.type === "noul" ? a.noul : null;
}

// Sort a Choice's probabilities descending → [[option, p], ...].
export function ranked(c: ChoiceAnswer | null): Array<[string, number]> {
  if (!c) return [];
  return Object.entries(c.probabilities).sort((a, b) => b[1] - a[1]);
}
