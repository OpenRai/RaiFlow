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

  it('constructs WebSocket client without an explicit URL', () => {
    const client = new NanoWebSocketClient({});
    expect(client.getAuditReport()[0]?.url).toBe('wss://rpc.nano.to/');
  });
});
