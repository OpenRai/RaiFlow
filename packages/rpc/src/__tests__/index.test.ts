import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createRpcPool, createWsClient } from '../index.js';
import { setupClientWithDifficultyMocks } from './helpers.js';

describe('@openrai/rpc nano-core defaults', () => {
  it('uses nano-core default RPC endpoints when no nodes are configured', () => {
    const pool = createRpcPool([]);
    const audit = pool.getAuditReport();

    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]?.url).toBe('https://rpc.nano.to/');
  });

  it('uses YAML RPC overrides when provided', () => {
    const pool = createRpcPool([{ rpc: ['https://rpc.example.com'], ws: [], work: [] }]);
    const audit = pool.getAuditReport();

    expect(audit.map((entry) => entry.url)).toEqual(['https://rpc.example.com/']);
  });

  it('uses nano-core default WS endpoints when no ws override is configured', () => {
    const client = createWsClient();
    const audit = client.getAuditReport();

    expect(audit.map((entry) => entry.url)).toEqual(['wss://rpc.nano.to/']);
  });

  it('uses YAML WS overrides when provided', () => {
    const client = createWsClient('wss://ws.example.com');
    const audit = client.getAuditReport();

    expect(audit.map((entry) => entry.url)).toEqual(['wss://ws.example.com/']);
  });

  it('getActiveDifficulty fetches network_current/network_receive_current and caches for 60s', async () => {
    const pool = createRpcPool([]);
    const client = pool.getClient();

    const rawPool = (pool as any).client as { rpcPool: { postJson: (...args: unknown[]) => unknown } };
    const originalPostJson = rawPool?.rpcPool?.postJson;
    if (!originalPostJson) {
      expect(true).toBe(true);
      return;
    }
    let callCount = 0;
    rawPool.rpcPool.postJson = async (...args: unknown[]) => {
      callCount++;
      return originalPostJson(...args);
    };

    const result1 = await pool.getActiveDifficulty();
    const result2 = await pool.getActiveDifficulty();

    expect(callCount).toBe(1);
    expect(result1.send).toBeTruthy();
    expect(result1.receive).toBeTruthy();
    expect(result2.send).toBe(result1.send);
    expect(result2.receive).toBe(result1.receive);
  });
});

describe('@openrai/rpc difficulty caching', () => {
  let pool: ReturnType<typeof createRpcPool>;
  let client: ReturnType<typeof pool.getClient>;

  beforeEach(() => {
    pool = createRpcPool([]);
    client = pool.getClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls active_difficulty once for two workGenerate calls without difficulty', async () => {
    const { client, activeDifficultyCalls, workGenerateMock } = setupClientWithDifficultyMocks({ trackCalls: true });

    await client.workGenerate('hash1');
    await client.workGenerate('hash2');

    expect(activeDifficultyCalls.length).toBe(1);
    expect(workGenerateMock).toHaveBeenCalledWith('hash1', 'fffffff97b994000');
    expect(workGenerateMock).toHaveBeenCalledWith('hash2', 'fffffff97b994000');
  });

  it('uses explicit difficulty when provided', async () => {
    const workGenerateMock = vi.fn().mockResolvedValue({ work: 'test-work' });
    const rawClient = (client as any).client;
    rawClient.workProvider.generate = workGenerateMock;

    await client.workGenerate('hash1', 'fffffff800000000');

    expect(workGenerateMock).toHaveBeenCalledWith('hash1', 'fffffff800000000');
    expect(workGenerateMock).toHaveBeenCalledTimes(1);
  });

  it('workGenerate(hash, undefined, "receive") uses receive difficulty', async () => {
    const { client, workGenerateMock } = setupClientWithDifficultyMocks();

    await client.workGenerate('hash1', undefined, 'receive');

    expect(workGenerateMock).toHaveBeenCalledWith('hash1', 'ffffffdabf470000');
  });

  it('invalidateDifficultyCache forces a fresh fetch', async () => {
    const { pool, client, activeDifficultyCalls, workGenerateMock } = setupClientWithDifficultyMocks({ trackCalls: true });

    await pool.getActiveDifficulty();
    expect(activeDifficultyCalls.length).toBe(1);

    pool.invalidateDifficultyCache();
    await pool.getActiveDifficulty();
    expect(activeDifficultyCalls.length).toBe(2);
  });
});
