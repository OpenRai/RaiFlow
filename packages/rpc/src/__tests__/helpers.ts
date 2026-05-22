// @openrai/rpc — Shared test helpers

import { vi } from 'vitest';
import { createRpcPool } from '../index.js';

export function setupClientWithWorkMocks() {
  const pool = createRpcPool([]);
  const client = pool.getClient();
  return { pool, client };
}
