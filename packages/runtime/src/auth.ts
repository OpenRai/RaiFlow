// @openrai/runtime — API key resolution

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
export function resolveApiKey(config: RaiFlowConfig): ApiKeyResolution {
  if (process.env['RAIFLOW_API_KEY']) {
    return { apiKey: process.env['RAIFLOW_API_KEY'], source: 'env' };
  }

  const configuredKey = config.daemon.apiKey;
  if (configuredKey) {
    return { apiKey: configuredKey, source: 'config' };
  }

  throw new Error(
    'RAIFLOW_API_KEY is required. Set it as an environment variable or in raiflow.yml under daemon.apiKey.',
  );
}
