// @openrai/runtime — SendOrchestrator tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SendStore, AccountStore, RaiFlowEvent } from '@openrai/model';
import type { CustodyEngine } from '@openrai/custody';
import type { RpcPool } from '@openrai/rpc';
import { SendOrchestrator } from '../send-orchestrator.js';

const TEST_ACCOUNT_ADDRESS = 'nano_1testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg';

function createMockRpcPool(): RpcPool {
  return {
    getClient: vi.fn(),
    addNode: vi.fn(),
    removeNode: vi.fn(),
    getActiveNode: vi.fn(),
    onStateChange: vi.fn(),
    getAuditReport: vi.fn(),
  };
}

function createMockCustodyEngine(overrides?: Partial<{
  signSend: ReturnType<typeof vi.fn>;
  generateWork: ReturnType<typeof vi.fn>;
  generateReceiveWork: ReturnType<typeof vi.fn>;
}>): CustodyEngine {
  return {
    loadSeed: vi.fn(),
    deriveInvoiceAddress: vi.fn(),
    deriveManagedAccount: vi.fn(),
    getNextInvoiceIndex: vi.fn(),
    getNextManagedIndex: vi.fn(),
    setRepresentative: vi.fn(),
    signSend: vi.fn(),
    signReceive: vi.fn(),
    signChange: vi.fn(),
    generateWork: vi.fn(),
    generateReceiveWork: vi.fn(),
    ...overrides,
  };
}

function createMockSendStore(): SendStore {
  return {
    create: vi.fn(),
    get: vi.fn(),
    getByBlockHash: vi.fn(),
    listByAccount: vi.fn(),
    listByStatus: vi.fn(),
    getByIdempotencyKey: vi.fn(),
    update: vi.fn(),
  };
}

function createMockAccountStore(): AccountStore {
  return {
    create: vi.fn(),
    get: vi.fn(),
    getByAddress: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function makeSend(overrides?: Partial<Parameters<SendStore['update']>[1]>): Parameters<SendStore['update']>[1] & { id: string; accountId: string; destination: string; amountRaw: string } {
  return {
    id: 'send-1',
    accountId: 'account-1',
    destination: 'nano_1dest1111111111111111111111111111111111111111111111111111',
    amountRaw: '1000000000000000000000000000000',
    status: 'queued',
    blockHash: null,
    idempotencyKey: 'idem-1',
    createdAt: new Date().toISOString(),
    publishedAt: null,
    confirmedAt: null,
    ...overrides,
  };
}

interface TestAccount {
  id: string;
  accountKey: string;
  type: 'managed';
  address: string;
  label: null;
  balanceRaw: string;
  pendingRaw: string;
  frontier: null | string;
  representative: null | string;
  derivationIndex: number | null;
  createdAt: string;
  updatedAt: string;
}

function makeAccount(overrides?: Partial<TestAccount>): TestAccount {
  return {
    id: 'account-1',
    accountKey: 'test-account',
    type: 'managed' as const,
    address: TEST_ACCOUNT_ADDRESS,
    label: null,
    balanceRaw: '5000000000000000000000000000000',
    pendingRaw: '0',
    frontier: '0000000000000000000000000000000000000000000000000000000000000000',
    representative: 'nano_1rep1111111111111111111111111111111111111111111111111111',
    derivationIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSignedBlock(hash = 'abc123hash0000000000000000000000000000000000000000000000000000') {
  return {
    contents: JSON.stringify({
      type: 'send',
      account: TEST_ACCOUNT_ADDRESS,
      previous: '0000000000000000000000000000000000000000000000000000000000000000',
      representative: 'nano_1rep1111111111111111111111111111111111111111111111111111',
      balance: '4000000000000000000000000000000',
      link: 'nano_1dest1111111111111111111111111111111111111111111111111111',
    }),
    signature: 'sig00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    hash,
  };
}

describe('SendOrchestrator', () => {
  let sendStore: ReturnType<typeof createMockSendStore>;
  let accountStore: ReturnType<typeof createMockAccountStore>;
  let custodyEngine: ReturnType<typeof createMockCustodyEngine>;
  let rpcPool: RpcPool;
  let emittedEvents: RaiFlowEvent[];
  let orchestrator: SendOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    sendStore = createMockSendStore();
    accountStore = createMockAccountStore();
    custodyEngine = createMockCustodyEngine();
    rpcPool = createMockRpcPool();
    emittedEvents = [];

    orchestrator = new SendOrchestrator(
      sendStore,
      accountStore,
      custodyEngine,
      rpcPool,
      async (event) => { emittedEvents.push(event); },
    );
  });

  it('does not overlap worker ticks', async () => {
    let release: (() => void) | undefined;
    (sendStore.listByStatus as ReturnType<typeof vi.fn>).mockImplementation(() =>
      new Promise((resolve) => { release = () => resolve([]); }),
    );

    const first = orchestrator.tick();
    await orchestrator.tick();
    expect(sendStore.listByStatus).toHaveBeenCalledTimes(1);
    release?.();
    await first;
  });

  it('publishes send on happy path', async () => {
    const send = makeSend();
    const account = makeAccount();

    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (sendStore.listByStatus as ReturnType<typeof vi.fn>).mockResolvedValue([send]);
    (sendStore.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...send, status: 'published' });
    (custodyEngine.signSend as ReturnType<typeof vi.fn>).mockResolvedValue(makeSignedBlock());
    (custodyEngine.generateWork as ReturnType<typeof vi.fn>).mockResolvedValue('work000000000000000');

    const mockClient = {
      accountInfo: vi.fn().mockResolvedValue({
        frontier: '0000000000000000000000000000000000000000000000000000000000000000',
        balance: '5000000000000000000000000000000',
        representative: account.representative,
        blockCount: 1,
      }),
      process: vi.fn().mockResolvedValue({ hash: 'blockhash123' }),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    await orchestrator.tick();

    expect(custodyEngine.generateWork).toHaveBeenCalledWith(expect.any(String));
    expect(mockClient.process).toHaveBeenCalledTimes(1);
    expect(sendStore.update).toHaveBeenCalledWith('send-1', expect.objectContaining({ status: 'published' }));
  });

  it('retries once on work rejection then succeeds', async () => {
    const send = makeSend();
    const account = makeAccount();

    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (sendStore.listByStatus as ReturnType<typeof vi.fn>).mockResolvedValue([send]);
    (sendStore.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...send, status: 'published' });
    (custodyEngine.signSend as ReturnType<typeof vi.fn>).mockResolvedValue(makeSignedBlock());
    (custodyEngine.generateWork as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('work000000000000000')
      .mockResolvedValueOnce('work111111111111111');

    const mockClient = {
      accountInfo: vi.fn().mockResolvedValue({
        frontier: '0000000000000000000000000000000000000000000000000000000000000000',
        balance: '5000000000000000000000000000000',
        representative: account.representative,
        blockCount: 1,
      }),
      process: vi.fn()
        .mockRejectedValueOnce(new Error('Block work is less than threshold'))
        .mockResolvedValueOnce({ hash: 'blockhash123' }),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    await orchestrator.tick();

    expect(custodyEngine.generateWork).toHaveBeenCalledTimes(2);
    expect(mockClient.process).toHaveBeenCalledTimes(2);
    expect(sendStore.update).toHaveBeenCalledWith('send-1', expect.objectContaining({ status: 'published' }));
  });

  it('recovers an ambiguous prior publish when the node reports Old block', async () => {
    const send = makeSend();
    const account = makeAccount();
    const signed = makeSignedBlock('already-published-hash');
    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (sendStore.listByStatus as ReturnType<typeof vi.fn>).mockResolvedValue([send]);
    (sendStore.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...send, status: 'published' });
    (custodyEngine.signSend as ReturnType<typeof vi.fn>).mockResolvedValue(signed);
    (custodyEngine.generateWork as ReturnType<typeof vi.fn>).mockResolvedValue('work000000000000000');
    const mockClient = {
      accountInfo: vi.fn().mockResolvedValue({
        frontier: '0'.repeat(64),
        balance: '5000000000000000000000000000000',
        representative: account.representative,
        blockCount: 1,
      }),
      process: vi.fn().mockRejectedValue(new Error('process error: Old block')),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    await orchestrator.tick();

    expect(sendStore.update).toHaveBeenCalledWith('send-1', expect.objectContaining({
      status: 'published',
      blockHash: 'already-published-hash',
    }));
  });

  it('marks send as failed when both process attempts fail with work error', async () => {
    const send = makeSend();
    const account = makeAccount();

    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (sendStore.listByStatus as ReturnType<typeof vi.fn>).mockResolvedValue([send]);
    (sendStore.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...send, status: 'failed' });
    (custodyEngine.signSend as ReturnType<typeof vi.fn>).mockResolvedValue(makeSignedBlock());
    (custodyEngine.generateWork as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('work000000000000000')
      .mockResolvedValueOnce('work111111111111111');

    const mockClient = {
      accountInfo: vi.fn().mockResolvedValue({
        frontier: '0000000000000000000000000000000000000000000000000000000000000000',
        balance: '5000000000000000000000000000000',
        representative: account.representative,
        blockCount: 1,
      }),
      process: vi.fn()
        .mockRejectedValueOnce(new Error('Block work is less than threshold'))
        .mockRejectedValueOnce(new Error('Block work is less than threshold')),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    await orchestrator.tick();

    expect(mockClient.process).toHaveBeenCalledTimes(2);
    expect(sendStore.update).toHaveBeenCalledWith('send-1', expect.objectContaining({ status: 'failed' }));
    expect(emittedEvents).toContainEqual(expect.objectContaining({ type: 'send.failed' }));
  });

  it('fails immediately on non-work error without retry', async () => {
    const send = makeSend();
    const account = makeAccount();

    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (sendStore.listByStatus as ReturnType<typeof vi.fn>).mockResolvedValue([send]);
    (sendStore.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...send, status: 'failed' });
    (custodyEngine.signSend as ReturnType<typeof vi.fn>).mockResolvedValue(makeSignedBlock());
    (custodyEngine.generateWork as ReturnType<typeof vi.fn>).mockResolvedValue('work000000000000000');

    const mockClient = {
      accountInfo: vi.fn().mockResolvedValue({
        frontier: '0000000000000000000000000000000000000000000000000000000000000000',
        balance: '5000000000000000000000000000000',
        representative: account.representative,
        blockCount: 1,
      }),
      process: vi.fn().mockRejectedValue(new Error('Fork')),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    await orchestrator.tick();

    expect(mockClient.process).toHaveBeenCalledTimes(1);
    expect(sendStore.update).toHaveBeenCalledWith('send-1', expect.objectContaining({ status: 'failed' }));
    expect(emittedEvents).toContainEqual(expect.objectContaining({ type: 'send.failed' }));
  });

  it('fails immediately when work rejection retry also fails', async () => {
    const send = makeSend();
    const account = makeAccount();

    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (sendStore.listByStatus as ReturnType<typeof vi.fn>).mockResolvedValue([send]);
    (sendStore.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...send, status: 'failed' });
    (custodyEngine.signSend as ReturnType<typeof vi.fn>).mockResolvedValue(makeSignedBlock());
    (custodyEngine.generateWork as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('work000000000000000')
      .mockResolvedValueOnce('work111111111111111');

    const mockClient = {
      accountInfo: vi.fn().mockResolvedValue({
        frontier: '0000000000000000000000000000000000000000000000000000000000000000',
        balance: '5000000000000000000000000000000',
        representative: account.representative,
        blockCount: 1,
      }),
      process: vi.fn()
        .mockRejectedValueOnce(new Error('Block work is less than threshold'))
        .mockRejectedValueOnce(new Error('Block work is less than threshold')),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    await orchestrator.tick();

    expect(mockClient.process).toHaveBeenCalledTimes(2);
    expect(sendStore.update).toHaveBeenCalledWith('send-1', expect.objectContaining({ status: 'failed' }));
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      type: 'send.failed',
      data: expect.objectContaining({ reason: 'Block work is less than threshold' }),
    }));
  });

  it('does NOT fall back to ZERO_HASH on transient RPC error', async () => {
    const send = makeSend();
    const account = makeAccount();

    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (sendStore.listByStatus as ReturnType<typeof vi.fn>).mockResolvedValue([send]);
    (sendStore.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...send, status: 'failed' });

    const mockClient = {
      accountInfo: vi.fn().mockRejectedValue(new Error('RPC timeout')),
      process: vi.fn(),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    await orchestrator.tick();

    expect(mockClient.process).not.toHaveBeenCalled();
    expect(sendStore.update).toHaveBeenCalledWith('send-1', expect.objectContaining({ status: 'failed' }));
    expect(emittedEvents).toContainEqual(expect.objectContaining({
      type: 'send.failed',
      data: expect.objectContaining({ reason: 'RPC timeout' }),
    }));
  });
});
