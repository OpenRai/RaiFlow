// @openrai/rpc — Shared test helpers

import { vi } from 'vitest';
import { createRpcPool } from '../index.js';

export const DIFFICULTY_RESPONSE = {
  network_minimum: 'fffffff800000000',
  network_receive_minimum: 'fffffe0000000000',
  network_current: 'fffffff97b994000',
  network_receive_current: 'ffffffdabf470000',
};

export function setupClientWithDifficultyMocks(options?: { trackCalls?: boolean }) {
  const trackCalls = options?.trackCalls ?? false;
  const activeDifficultyCalls: unknown[] = [];
  const workGenerateMock = vi.fn().mockResolvedValue({ work: 'test-work' });

  const pool = createRpcPool([]);
  const client = pool.getClient();
  const rawClient = (client as any).client;
  const originalPostJson = rawClient.rpcPool.postJson.bind(rawClient.rpcPool);

  rawClient.rpcPool.postJson = async (payload: Record<string, unknown>) => {
    if (payload.action === 'active_difficulty') {
      if (trackCalls) activeDifficultyCalls.push(payload);
      return DIFFICULTY_RESPONSE;
    }
    return originalPostJson(payload);
  };
  rawClient.workProvider.generate = workGenerateMock;

  return { pool, client, activeDifficultyCalls, workGenerateMock };
}