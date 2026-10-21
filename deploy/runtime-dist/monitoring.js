export function createRuntimeMetrics(options) {
    const collector = {
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
            if (sample.status >= 500)
                this.status5xx += 1;
            else if (sample.status >= 400)
                this.status4xx += 1;
            else if (sample.status >= 200 && sample.status < 300)
                this.status2xx += 1;
            else
                this.statusOther += 1;
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
//# sourceMappingURL=monitoring.js.map