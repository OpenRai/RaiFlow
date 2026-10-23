// @openrai/runtime — SendOrchestrator tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Send, SendStore, AccountStore, RaiFlowEvent } from '@openrai/model';
import type { CustodyEngine } from '@openrai/custody';
import type { RpcPool } from '@openrai/rpc';
import { createInMemorySendBlockIntentStore } from '../send-block-intents.js';
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

function makeSend(overrides?: Partial<Send>): Send {
  return {
    id: 'send-1',
    source: { type: 'account', accountId: 'account-1', address: TEST_ACCOUNT_ADDRESS, derivationIndex: 1 },
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
const DEFAULT_BLOCK_HASH = makeSignedBlock().hash;

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
    (sendStore.listByStatus as ReturnType<typeof vi.fn>).mockImplementation((status: string) =>
      status === 'queued'
        ? new Promise((resolve) => { release = () => resolve([]); })
        : Promise.resolve([]),
    );

    const first = orchestrator.tick();
    await orchestrator.tick();
    expect(sendStore.listByStatus).toHaveBeenCalledTimes(2);
    expect(sendStore.listByStatus).toHaveBeenCalledWith('queued');
    expect(sendStore.listByStatus).toHaveBeenCalledWith('published');
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
      process: vi.fn().mockResolvedValue({ hash: DEFAULT_BLOCK_HASH }),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    await orchestrator.tick();

    expect(custodyEngine.generateWork).toHaveBeenCalledWith(expect.any(String));
    expect(mockClient.process).toHaveBeenCalledTimes(1);
    expect(sendStore.update).toHaveBeenCalledWith('send-1', expect.objectContaining({ status: 'published' }));
  });

  it('publishes invoice sends from their persisted derivation source without an account row', async () => {
    const invoiceAddress = 'nano_1invoiceaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg';
    const send = makeSend({
      source: { type: 'invoice', invoiceId: 'invoice-1', address: invoiceAddress, derivationIndex: 12 },
      amountRaw: '100',
    });
    (sendStore.listByStatus as ReturnType<typeof vi.fn>).mockImplementation(async (status: string) =>
      status === 'queued' ? [send] : [],
    );
    (sendStore.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...send, status: 'published' });
    (custodyEngine.signSend as ReturnType<typeof vi.fn>).mockResolvedValue(makeSignedBlock());
    (custodyEngine.generateWork as ReturnType<typeof vi.fn>).mockResolvedValue('work000000000000000');
    const mockClient = {
      accountInfo: vi.fn().mockResolvedValue({ frontier: '0'.repeat(64), balance: '500' }),
      process: vi.fn().mockResolvedValue({ hash: DEFAULT_BLOCK_HASH }),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    await orchestrator.tick();

    expect(custodyEngine.signSend).toHaveBeenCalledWith(
      invoiceAddress,
      send.destination,
      '400',
      '0'.repeat(64),
      12,
    );
    expect(accountStore.get).not.toHaveBeenCalled();
    expect(accountStore.update).not.toHaveBeenCalled();
    expect(mockClient.process).toHaveBeenCalledOnce();
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
        .mockResolvedValueOnce({ hash: DEFAULT_BLOCK_HASH }),
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
      blockInfo: vi.fn().mockResolvedValue({ confirmed: false }),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    await orchestrator.tick();

    expect(sendStore.update).toHaveBeenCalledWith('send-1', expect.objectContaining({
      status: 'published',
      blockHash: 'already-published-hash',
    }));
  });

  it('reuses the persisted exact block after an ambiguous timeout and restart', async () => {
    const send = makeSend();
    const account = makeAccount();
    const signed = makeSignedBlock('restart-safe-hash');
    const intentStore = createInMemorySendBlockIntentStore();
    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (sendStore.listByStatus as ReturnType<typeof vi.fn>).mockResolvedValue([send]);
    (sendStore.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...send, status: 'published' });
    (custodyEngine.signSend as ReturnType<typeof vi.fn>).mockResolvedValue(signed);
    (custodyEngine.generateWork as ReturnType<typeof vi.fn>).mockResolvedValue('work000000000000000');

    let firstBlockJson: string | undefined;
    const firstClient = {
      accountInfo: vi.fn().mockResolvedValue({ frontier: 'frontier-a', balance: '5000000000000000000000000000000' }),
      process: vi.fn((blockJson: string) => {
        firstBlockJson = blockJson;
        return Promise.reject(new Error('request timed out'));
      }),
      blockInfo: vi.fn(),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(firstClient);
    orchestrator = new SendOrchestrator(
      sendStore,
      accountStore,
      custodyEngine,
      rpcPool,
      async (event) => { emittedEvents.push(event); },
      undefined,
      intentStore,
    );
    await orchestrator.tick();
    expect(sendStore.update).not.toHaveBeenCalled();

    let replayedBlockJson: string | undefined;
    const secondClient = {
      accountInfo: vi.fn(),
      process: vi.fn((blockJson: string) => {
        replayedBlockJson = blockJson;
        return Promise.reject(new Error('Old block'));
      }),
      blockInfo: vi.fn().mockResolvedValue({ confirmed: false }),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(secondClient);
    orchestrator = new SendOrchestrator(
      sendStore,
      accountStore,
      custodyEngine,
      rpcPool,
      async (event) => { emittedEvents.push(event); },
      undefined,
      intentStore,
    );
    await orchestrator.tick();

    expect(secondClient.accountInfo).not.toHaveBeenCalled();
    expect(custodyEngine.signSend).toHaveBeenCalledTimes(1);
    expect(replayedBlockJson).toBe(firstBlockJson);
    expect(secondClient.blockInfo).toHaveBeenCalledWith(signed.hash);
    expect(sendStore.update).toHaveBeenCalledWith('send-1', expect.objectContaining({
      status: 'published',
      blockHash: signed.hash,
    }));
  });

  it('does not mark an accepted block failed when post-publish storage fails', async () => {
    const send = makeSend();
    const account = makeAccount();
    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (sendStore.listByStatus as ReturnType<typeof vi.fn>).mockImplementation((status: string) =>
      status === 'queued' ? [send] : [],
    );
    (sendStore.update as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('database unavailable'));
    (custodyEngine.signSend as ReturnType<typeof vi.fn>).mockResolvedValue(makeSignedBlock());
    (custodyEngine.generateWork as ReturnType<typeof vi.fn>).mockResolvedValue('work000000000000000');
    const mockClient = {
      accountInfo: vi.fn().mockResolvedValue({ frontier: 'frontier-a', balance: '5000000000000000000000000000000' }),
      process: vi.fn().mockResolvedValue({ hash: DEFAULT_BLOCK_HASH }),
      blockInfo: vi.fn(),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    await orchestrator.tick();

    expect(mockClient.process).toHaveBeenCalledTimes(1);
    expect(sendStore.update).toHaveBeenCalledWith('send-1', expect.objectContaining({ status: 'published' }));
    expect(emittedEvents).not.toContainEqual(expect.objectContaining({ type: 'send.failed' }));
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

  it('keeps the exact intent queued after an ambiguous non-work process error', async () => {
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
      process: vi.fn().mockRejectedValue(new Error('Fork')),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    await orchestrator.tick();

    expect(mockClient.process).toHaveBeenCalledTimes(1);
    expect(sendStore.update).not.toHaveBeenCalled();
    expect(emittedEvents).toEqual([]);
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

  it('keeps the send queued when account-info lookup fails before intent creation', async () => {
    const send = makeSend();
    const account = makeAccount();

    (accountStore.get as ReturnType<typeof vi.fn>).mockResolvedValue(account);
    (sendStore.listByStatus as ReturnType<typeof vi.fn>).mockResolvedValue([send]);

    const mockClient = {
      accountInfo: vi.fn().mockRejectedValue(new Error('RPC timeout')),
      process: vi.fn(),
    };
    (rpcPool.getClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    await orchestrator.tick();

    expect(mockClient.process).not.toHaveBeenCalled();
    expect(sendStore.update).not.toHaveBeenCalled();
    expect(emittedEvents).toEqual([]);
  });
});
