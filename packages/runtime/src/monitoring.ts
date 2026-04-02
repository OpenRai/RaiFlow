export interface RuntimeRequestSample {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  at: string;
}

export interface RuntimeMetricsSnapshot {
  startedAt: string;
  pid: number;
  dbPath: string;
  migrations: string[];
  requestCount: number;
  status2xx: number;
  status4xx: number;
  status5xx: number;
  statusOther: number;
  avgRequestMs: number;
  lastRequestAt: string | null;
  recentRequests: RuntimeRequestSample[];
  memoryRssBytes: number;
  memoryHeapUsedBytes: number;
  memoryHeapTotalBytes: number;
}

export interface RuntimeMetricsCollector extends RuntimeMetricsSnapshot {
  recordRequest(sample: Omit<RuntimeRequestSample, 'at'> & { at?: string }): void;
  refreshProcessMetrics(): void;
}

export function createRuntimeMetrics(options: {
  dbPath: string;
  migrations: string[];
}): RuntimeMetricsCollector {
  const collector: RuntimeMetricsCollector = {
    startedAt: new Date().toISOString(),
    pid: process.pid,
    dbPath: options.dbPath,
    migrations: [...options.migrations],
    requestCount: 0,
    status2xx: 0,
    status4xx: 0,
    status5xx: 0,
    statusOther: 0,
    avgRequestMs: 0,
    lastRequestAt: null,
    recentRequests: [],
    memoryRssBytes: process.memoryUsage().rss,
    memoryHeapUsedBytes: process.memoryUsage().heapUsed,
    memoryHeapTotalBytes: process.memoryUsage().heapTotal,
    recordRequest(sample) {
      const at = sample.at ?? new Date().toISOString();

      this.requestCount += 1;
      this.lastRequestAt = at;

      if (sample.status >= 500) this.status5xx += 1;
      else if (sample.status >= 400) this.status4xx += 1;
      else if (sample.status >= 200 && sample.status < 300) this.status2xx += 1;
      else this.statusOther += 1;

      this.avgRequestMs = ((this.avgRequestMs * (this.requestCount - 1)) + sample.durationMs) / this.requestCount;
      this.recentRequests.unshift({ ...sample, at });
      this.recentRequests = this.recentRequests.slice(0, 24);
      this.refreshProcessMetrics();
    },
    refreshProcessMetrics() {
      const memory = process.memoryUsage();
      this.memoryRssBytes = memory.rss;
      this.memoryHeapUsedBytes = memory.heapUsed;
      this.memoryHeapTotalBytes = memory.heapTotal;
    },
  };

  return collector;
}
