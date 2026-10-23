import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createRpcPool, createWsClient } from '../index.js';

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

  it('routes work generation through the injected WorkProvider', async () => {
    const workProvider = { generate: vi.fn().mockResolvedValue('test-work') };
    const pool = createRpcPool([], workProvider);
    const client = pool.getClient();

    const result = await client.workGenerate('abc123');

    expect(workProvider.generate).toHaveBeenCalledWith('abc123', 'send');
    expect(result).toEqual({ work: 'test-work' });
  });

  it('fails clearly when the pool has no injected WorkProvider', async () => {
    await expect(createRpcPool([]).getClient().workGenerate('abc123'))
      .rejects.toThrow('WorkProvider is not configured');
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

  it('normalizes the account-scoped accounts_receivable response', async () => {
    const account = 'nano_1testaccountxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    mockPostJson(() => ({
      blocks: {
        [account]: {
          block_hash_nested: { amount: '7', source: 'nano_1sender' },
        },
      },
    }));

    await expect(client.accountsReceivable(account)).resolves.toEqual([{
      hash: 'block_hash_nested', amount: '7', sender: 'nano_1sender',
    }]);
  });
});

describe('@openrai/rpc process', () => {
  it('rejects Nano RPC application errors and malformed success responses', async () => {
    const client = createRpcPool([]).getClient() as any;
    client.rpcCall = vi.fn().mockResolvedValueOnce({ error: 'Old block' });
    await expect(client.process('{}')).rejects.toThrow('Old block');

    client.rpcCall = vi.fn().mockResolvedValueOnce({});
    await expect(client.process('{}')).rejects.toThrow('did not include a block hash');
  });

  it('returns a validated process hash', async () => {
    const client = createRpcPool([]).getClient() as any;
    client.rpcCall = vi.fn().mockResolvedValue({ hash: 'ABC' });
    await expect(client.process('{}')).resolves.toEqual({ hash: 'ABC' });
  });
});

describe('@openrai/rpc blockInfo', () => {
  it('decodes a state-send destination for direct invoice matching', async () => {
    const client = createRpcPool([]).getClient() as any;
    client.rpcCall = vi.fn().mockResolvedValue({
      confirmed: 'true',
      subtype: 'send',
      block_account: 'nano_1sender',
      amount: '1',
      local_timestamp: '42',
      contents: { link_as_account: 'nano_1recipient' },
    });
    await expect(client.blockInfo('A'.repeat(64))).resolves.toEqual({
      confirmed: true,
      subtype: 'send',
      blockAccount: 'nano_1sender',
      amount: '1',
      recipientAccount: 'nano_1recipient',
      localTimestamp: '42',
    });
  });
});

describe('@openrai/rpc endpoint failover', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails over when a provider returns a JSON rate-limit error', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 429 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        frontier: 'ABC', balance: '7', representative: 'nano_1rep', block_count: '1',
      }), { status: 200 }));
    const pool = createRpcPool([{ rpc: ['https://limited.example.com', 'https://healthy.example.com'], ws: [] }]);

    await expect(pool.getClient().accountInfo('nano_1account')).resolves.toEqual({
      frontier: 'ABC', balance: '7', representative: 'nano_1rep', block_count: '1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('healthy.example.com');
  });

  it('uses nano-core Bearer URL shorthand and redacts credentials in audit output', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      frontier: 'ABC', balance: '7', representative: 'nano_1rep', block_count: '1',
    }), { status: 200 }));
    const pool = createRpcPool([{ rpc: ['https://secret-token@auth.example.com/rpc'], ws: [] }]);

    await pool.getClient().accountInfo('nano_1account');

    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer secret-token');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://auth.example.com/rpc');
    expect(pool.getAuditReport()[0]?.url).toBe('https://auth.example.com/rpc');
    expect(JSON.stringify(pool.getAuditReport())).not.toContain('secret-token');
  });

  it('preserves unsupported-action JSON for operation fallbacks without cooling the endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Action not allowed' }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ blocks: { ABC123: { amount: '1', source: 'nano_1sender' } } }), { status: 200 }));
    const pool = createRpcPool([{ rpc: ['https://provider.example.com/rpc'], ws: [] }]);

    await expect(pool.getClient().accountsReceivableBatch(['nano_1account'], 20))
      .resolves.toEqual({ nano_1account: ['ABC123'] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((pool.getAuditReport()[0]?.consecutiveFailures)).toBe(0);
  });
});

describe('@openrai/rpc healthCheck', () => {
  it('requires a successful version response with a node vendor', async () => {
    const client = createRpcPool([]).getClient() as any;
    client.rpcCall = vi.fn().mockResolvedValueOnce({ node_vendor: 'Nano V28' });
    await expect(client.healthCheck()).resolves.toBeUndefined();

    client.rpcCall = vi.fn().mockResolvedValueOnce({});
    await expect(client.healthCheck()).rejects.toThrow('node_vendor');
  });
});
