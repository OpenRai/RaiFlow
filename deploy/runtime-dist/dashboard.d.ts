import type { RaiFlowConfig } from '@openrai/config';
import type { Runtime } from './runtime.js';
import type { RuntimeMetricsSnapshot } from './monitoring.js';
export declare function renderDashboard(runtime: Runtime, options?: {
    view?: string;
    config?: RaiFlowConfig;
    metrics?: RuntimeMetricsSnapshot;
    showInternal?: boolean;
    version?: string;
}): Promise<string>;
