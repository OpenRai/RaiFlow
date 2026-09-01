import { describe, expect, it, vi } from 'vitest';
import { NanoRpcClient } from '../rpc.js';
import { NanoWebSocketClient } from '../websocket.js';

vi.mock('nano-rspow-node', () => ({
  generateWork: vi.fn().mockResolvedValue('test-work'),
  WorkType: { Send: 'Send', Receive: 'Receive', Epoch1: 'Epoch1', Dev: 'Dev' },
}));

describe('@openrai/watcher nano-core defaults', () => {
  it('constructs RPC client without an explicit URL and uses nano-core defaults', () => {
    const client = new NanoRpcClient({});
    expect(client.getAuditReport()[0]?.url).toBe('https://rpc.nano.to/');
  });

  it('retains all configured RPC URLs for failover', () => {
    const client = new NanoRpcClient({
      urls: ['https://first.example/proxy', 'https://second.example/proxy'],
    });
    expect(client.getAuditReport().map((entry) => entry.url)).toEqual([
      'https://first.example/proxy',
      'https://second.example/proxy',
    ]);
  });

  it('constructs WebSocket client without an explicit URL', () => {
    const client = new NanoWebSocketClient({});
    expect(client.getAuditReport()[0]?.url).toBe('wss://rpc.nano.to/');
  });

  it('falls back to pending when a provider disables accounts_receivable', async () => {
    const client = new NanoRpcClient({ url: 'https://nanoslo.example/proxy' }) as any;
    const postJson = vi.fn()
      .mockRejectedValueOnce(new Error('RPC request failed: HTTP error 500 Internal Server Error'))
      .mockResolvedValueOnce({
        blocks: { ABC123: { amount: '1', source: 'nano_1sender' } },
      });
    client.client.rpcPool.postJson = postJson;

    await expect(client.accountsReceivable(['nano_1account'], 20)).resolves.toEqual({
      nano_1account: ['ABC123'],
    });
    expect(postJson).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: 'pending',
      account: 'nano_1account',
    }));
  });
});
