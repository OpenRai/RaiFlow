export interface RuntimeRequestSample {
    method: string;
    path: string;
    status: number;
    durationMs: number;
    at: string;
    isDashboard?: boolean;
    remoteAddr?: string;
    headers?: Record<string, string>;
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
    recordRequest(sample: Omit<RuntimeRequestSample, 'at'> & {
        at?: string;
    }): void;
    refreshProcessMetrics(): void;
}
export declare function createRuntimeMetrics(options: {
    dbPath: string;
    migrations: string[];
}): RuntimeMetricsCollector;
