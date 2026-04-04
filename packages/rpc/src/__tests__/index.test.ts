import { describe, expect, it } from 'vitest';
import { createRpcPool, createWsClient } from '../index.js';

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
});
