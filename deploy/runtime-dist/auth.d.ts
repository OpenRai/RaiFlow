import type { RaiFlowConfig } from '@openrai/config';
export interface ApiKeyResolution {
    /** The effective API key string. */
    apiKey: string;
    /** Where the key came from. */
    source: 'env' | 'config';
}
/**
 * Resolve the effective API key for the runtime.
 *
 * 1. If `RAIFLOW_API_KEY` env var is set, use it.
 * 2. If `config.daemon.apiKey` is set (via env: ref or literal), use it.
 * 3. Otherwise, throw with a clear message.
 */
export declare function resolveApiKey(config: RaiFlowConfig): ApiKeyResolution;
