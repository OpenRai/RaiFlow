// @openrai/rpc — Shared test helpers
import { createRpcPool } from '../index.js';
export function setupClientWithWorkMocks() {
    const pool = createRpcPool([]);
    const client = pool.getClient();
    return { pool, client };
}
//# sourceMappingURL=helpers.js.map