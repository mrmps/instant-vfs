export interface Metrics {
  strategy: string;
  repo: string;
  ok: boolean;
  error?: string;
  wallMs: number;
  treeReadyMs?: number;
  bytesIn: number;
  bytesStored: number;
  filesTotal: number;
  filesStored: number;
  filesSkipped: number;
  apiCalls: number;
  peakRssMb: number;
  notes?: string;
}

export function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

export function sampleRss(): number {
  const { rss } = process.memoryUsage();
  return rss;
}

export class RssWatcher {
  private max = 0;
  private timer: Timer | null = null;
  start() {
    this.max = sampleRss();
    this.timer = setInterval(() => {
      const r = sampleRss();
      if (r > this.max) this.max = r;
    }, 25);
  }
  stop(): number {
    if (this.timer) clearInterval(this.timer);
    return this.max;
  }
}
