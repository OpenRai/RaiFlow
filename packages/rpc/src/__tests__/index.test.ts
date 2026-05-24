import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createRpcPool, createWsClient } from '../index.js';

vi.mock('nano-rspow-node', () => ({
  generateWork: vi.fn().mockResolvedValue('test-work'),
  WorkType: { Send: 'Send', Receive: 'Receive', Epoch1: 'Epoch1', Dev: 'Dev' },
}));

describe('@openrai/rpc nano-core defaults', () => {
  it('uses nano-core default RPC endpoints when no nodes are configured', () => {
    const pool = createRpcPool([]);
    const audit = pool.getAuditReport();

    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]?.url).toBe('https://rpc.nano.to/');
  });

  it('uses YAML RPC overrides when provided', () => {
    const pool = createRpcPool([{ rpc: ['https://rpc.example.com'], ws: [] }]);
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
});

describe('@openrai/rpc workGenerate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('workGenerate calls rspow with WorkType.Send and returns work string', async () => {
    const { generateWork } = await import('nano-rspow-node');
    const pool = createRpcPool([]);
    const client = pool.getClient();

    const result = await client.workGenerate('abc123');

    expect(generateWork).toHaveBeenCalledWith('abc123', 'Send');
    expect(result).toEqual({ work: 'test-work' });
  });
});

describe('@openrai/rpc accountsReceivable', () => {
  let pool: ReturnType<typeof createRpcPool>;
  let client: ReturnType<typeof pool.getClient>;

  beforeEach(() => {
    pool = createRpcPool([]);
    client = pool.getClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockPostJson(handler: (payload: Record<string, unknown>) => unknown) {
    const pooledClient = client as any;
    const originalRpcCall = pooledClient.rpcCall?.bind(pooledClient);
    if (pooledClient.rpcCall) {
      pooledClient.rpcCall = async (payload: Record<string, unknown>) => {
        if (payload.action === 'accounts_receivable') {
          return handler(payload);
        }
        if (originalRpcCall) return originalRpcCall(payload);
        throw new Error('No handler for action: ' + payload.action);
      };
    }
  }

  it('returns empty array when node reports Account not found', async () => {
    mockPostJson(() => {
      return { error: 'Account not found' };
    });

    const result = await client.accountsReceivable('nano_1unopenedaccountxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');

    expect(result).toEqual([]);
  });

  it('sends accounts (plural) parameter as an array', async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    mockPostJson((payload) => {
      capturedPayload = payload;
      return { blocks: {} };
    });

    await client.accountsReceivable('nano_1testaccountxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!['accounts']).toEqual(['nano_1testaccountxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx']);
    expect(capturedPayload!['account']).toBeUndefined();
  });

  it('returns empty array when response has no blocks field', async () => {
    mockPostJson(() => {
      return {} as any;
    });

    const result = await client.accountsReceivable('nano_1testaccountxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');

    expect(result).toEqual([]);
  });

  it('maps blocks to Receivable objects on success', async () => {
    mockPostJson(() => ({
      blocks: {
        block_hash_1: { amount: '1000000000000000000000000000000', sender: 'nano_1sender' },
        block_hash_2: { amount: '500000000000000000000000000000', sender: 'nano_2sender' },
      },
    }));

    const result = await client.accountsReceivable('nano_1testaccountxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');

    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      hash: 'block_hash_1',
      amount: '1000000000000000000000000000000',
      sender: 'nano_1sender',
    });
    expect(result).toContainEqual({
      hash: 'block_hash_2',
      amount: '500000000000000000000000000000',
      sender: 'nano_2sender',
    });
  });
});
