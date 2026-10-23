// @openrai/rpc — Shared test helpers

import { vi } from 'vitest';
import { createRpcPool } from '../index.js';

export function setupClientWithWorkMocks() {
  const pool = createRpcPool([], { generate: vi.fn().mockResolvedValue('mock-work') });
  const client = pool.getClient();
  return { pool, client };
}
