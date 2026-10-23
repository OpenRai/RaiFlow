import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReceiveTask, ReceiveTaskStore } from '@openrai/model';
import type { CustodyEngine } from '@openrai/custody';
import type { RpcPool } from '@openrai/rpc';
import { ReceiveOrchestrator } from '../receive-orchestrator.js';
import { createInMemoryReceiveBlockIntentStore } from '../receive-block-intents.js';
import { AccountOperationExecutor, createInMemoryAccountOperationLeaseStore } from '../account-operation-executor.js';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(assertion: () => void, timeoutMs = 400): Promise<void> {
  const started = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function createReceiveTaskStore() {
  const tasks = new Map<string, ReceiveTask>();
  const byPendingHash = new Map<string, string>();
  let seq = 0;

  const store: ReceiveTaskStore = {
    async create(task) {
      if (byPendingHash.has(task.pendingBlockHash)) {
        throw new Error('UNIQUE constraint failed: receive_tasks.pending_block_hash');
      }
      const created: ReceiveTask = {
        ...task,
        id: `task-${++seq}`,
        createdAt: new Date().toISOString(),
      };
      tasks.set(created.id, created);
      byPendingHash.set(created.pendingBlockHash, created.id);
      return created;
    },
    async get(id) {
      return tasks.get(id);
    },
    async getByPendingBlockHash(hash) {
      const id = byPendingHash.get(hash);
      return id ? tasks.get(id) : undefined;
    },
    async listByStatus(status) {
      return [...tasks.values()].filter((task) => task.status === status);
    },
    async update(id, patch) {
      const existing = tasks.get(id);
      if (!existing) throw new Error(`ReceiveTask ${id} not found`);
      const updated = { ...existing, ...patch };
      tasks.set(id, updated);
      return updated;
    },
  };

  return { store, tasks };
}

function createMockCustodyEngine(): CustodyEngine {
  return {
    loadSeed: vi.fn(),
    deriveInvoiceAddress: vi.fn(),
    deriveManagedAccount: vi.fn(),
    getNextInvoiceIndex: vi.fn(),
    getNextManagedIndex: vi.fn(),
    setRepresentative: vi.fn(),
    signSend: vi.fn(),
    signReceive: vi.fn().mockResolvedValue({ contents: JSON.stringify({ type: 'state' }), hash: 'published-hash' }),
    signChange: vi.fn(),
    generateWork: vi.fn(),
    generateReceiveWork: vi.fn().mockResolvedValue('test-work'),
  };
}

function createMockRpcClient() {
  return {
    accountsReceivable: vi.fn().mockResolvedValue([]),
    accountInfo: vi.fn().mockResolvedValue({ frontier: 'frontier-hash' }),
    process: vi.fn().mockResolvedValue({ hash: 'published-hash' }),
    blockInfo: vi.fn().mockResolvedValue(undefined),
    workGenerate: vi.fn(),
    getAuditReport: vi.fn().mockReturnValue([]),
  };
}

function createMockRpcPool(mockClient: ReturnType<typeof createMockRpcClient>): RpcPool {
  return {
    getClient: vi.fn().mockReturnValue(mockClient),
    addNode: vi.fn(),
    removeNode: vi.fn(),
    getActiveNode: vi.fn(),
    onStateChange: vi.fn(),
    getAuditReport: vi.fn().mockReturnValue([]),
  };
}

describe('ReceiveOrchestrator', () => {
  const accountAddress = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp';
  let receiveTaskStore: ReturnType<typeof createReceiveTaskStore>;
  let custodyEngine: CustodyEngine;
  let mockClient: ReturnType<typeof createMockRpcClient>;
  let rpcPool: RpcPool;
  let emitEvent: ReturnType<typeof vi.fn>;
  let orchestrator: ReceiveOrchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    receiveTaskStore = createReceiveTaskStore();
    custodyEngine = createMockCustodyEngine();
    mockClient = createMockRpcClient();
    rpcPool = createMockRpcPool(mockClient);
    emitEvent = vi.fn().mockResolvedValue(undefined);
    orchestrator = new ReceiveOrchestrator(receiveTaskStore.store, custodyEngine, rpcPool, emitEvent, undefined, undefined, 1n);
  });

  it('uses the configured minimum during recovery without recording skipped hashes', async () => {
    orchestrator = new ReceiveOrchestrator(receiveTaskStore.store, custodyEngine, rpcPool, emitEvent, undefined, undefined, 10n);
    mockClient.accountsReceivable.mockResolvedValue([
      { hash: 'dust', amount: '1' },
      { hash: 'below', amount: '9' },
      { hash: 'boundary', amount: '10' },
      { hash: 'above', amount: '11' },
    ]);
    await orchestrator.enqueueReceivables(accountAddress, 42);
    await orchestrator.enqueueReceivables(accountAddress, 42);
    expect([...receiveTaskStore.tasks.values()].map((task) => task.pendingBlockHash)).toEqual(['boundary', 'above']);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('skips old unsigned tasks below a raised minimum but recovers their saved signed intents', async () => {
    mockClient.accountsReceivable.mockResolvedValue([{ hash: 'old-dust', amount: '1' }]);
    await orchestrator.enqueueReceivables(accountAddress, 42);
    const [task] = [...receiveTaskStore.tasks.values()];
    const intents = createInMemoryReceiveBlockIntentStore();
    orchestrator = new ReceiveOrchestrator(receiveTaskStore.store, custodyEngine, rpcPool, emitEvent, undefined, intents, 10n);
    await orchestrator.processNext();
    expect(custodyEngine.signReceive).not.toHaveBeenCalled();
    expect(mockClient.process).not.toHaveBeenCalled();

    await intents.createIfAbsent({
      taskId: task!.id,
      blockHash: 'published-hash',
      blockJson: JSON.stringify({ type: 'state', work: 'saved-work' }),
      frontier: 'saved-frontier',
      resultingBalanceRaw: '1',
      createdAt: new Date().toISOString(),
    });
    await orchestrator.processNext();
    expect(mockClient.process).toHaveBeenCalledOnce();
    expect(custodyEngine.signReceive).not.toHaveBeenCalled();
    expect(await receiveTaskStore.store.get(task!.id)).toMatchObject({ status: 'published' });
    await orchestrator.handleConfirmedReceiveBlock('published-hash');
    expect(await receiveTaskStore.store.get(task!.id)).toMatchObject({ status: 'confirmed' });
  });

  describe('enqueueReceivables', () => {
    it('calls accountsReceivable on the rpc client', async () => {
      mockClient.accountsReceivable.mockResolvedValue([{ hash: 'h1', amount: '10' }]);

      orchestrator.enqueueReceivables(accountAddress, 42);

      await waitFor(() => {
        expect(mockClient.accountsReceivable).toHaveBeenCalledWith(accountAddress);
      });
    });

    it('creates a receive task for each pending block', async () => {
      mockClient.accountsReceivable.mockResolvedValue([
        { hash: 'h1', amount: '10' },
        { hash: 'h2', amount: '20' },
      ]);

      orchestrator.enqueueReceivables(accountAddress, 42);

      await waitFor(() => {
        expect(receiveTaskStore.tasks.size).toBe(2);
      });

      const hashes = [...receiveTaskStore.tasks.values()].map((task) => task.pendingBlockHash).sort();
      expect(hashes).toEqual(['h1', 'h2']);
      expect([...receiveTaskStore.tasks.values()].every((task) => task.status === 'pending')).toBe(true);
    });

    it("is idempotent: enqueueing same hash twice doesn't create duplicate tasks (second create throws UNIQUE, silently ignored)", async () => {
      mockClient.accountsReceivable.mockResolvedValue([{ hash: 'dup-hash', amount: '10' }]);

      orchestrator.enqueueReceivables(accountAddress, 42);
      await waitFor(() => {
        expect(receiveTaskStore.tasks.size).toBe(1);
      });

      orchestrator.enqueueReceivables(accountAddress, 42);
      await waitFor(() => {
        expect(mockClient.accountsReceivable).toHaveBeenCalledTimes(2);
      });

      expect(receiveTaskStore.tasks.size).toBe(1);
    });

    it('silently ignores RPC failure', async () => {
      mockClient.accountsReceivable.mockRejectedValue(new Error('rpc down'));

      expect(() => orchestrator.enqueueReceivables(accountAddress, 42)).not.toThrow();

      await waitFor(() => {
        expect(mockClient.accountsReceivable).toHaveBeenCalledWith(accountAddress);
      });
      expect(receiveTaskStore.tasks.size).toBe(0);
    });
  });

  describe('processNext', () => {
    it("processes a pending task: calls signReceive, generateReceiveWork, process, updates status to 'published'", async () => {
      const task = await receiveTaskStore.store.create({
        accountAddress,
        derivationIndex: 7,
        pendingBlockHash: 'pending-hash-1',
        amountRaw: '123',
        status: 'pending',
        publishedAt: null,
        confirmedAt: null,
        failedAt: null,
        failReason: null,
        retryCount: 0,
      });

      await orchestrator.processNext();

      expect(custodyEngine.signReceive).toHaveBeenCalledWith(
        accountAddress,
        'pending-hash-1',
        '123',
        'frontier-hash',
        7,
      );
      expect(custodyEngine.generateReceiveWork).toHaveBeenCalledWith('frontier-hash');
      expect(mockClient.process).toHaveBeenCalledTimes(1);

      const updated = await receiveTaskStore.store.get(task.id);
      expect(updated?.status).toBe('published');
      expect(updated?.publishedAt).toBeTruthy();
      expect(updated?.receiveBlockHash).toBe('published-hash');
      expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'receive.published' }));
    });

    it('uses the account public key as the work root for an unopened account', async () => {
      await receiveTaskStore.store.create({
        accountAddress,
        derivationIndex: 7,
        pendingBlockHash: 'open-source-hash',
        amountRaw: '123',
        status: 'pending',
        publishedAt: null,
        confirmedAt: null,
        failedAt: null,
        failReason: null,
        retryCount: 0,
      });
      mockClient.accountInfo.mockResolvedValue(undefined);

      await orchestrator.processNext();

      expect(custodyEngine.generateReceiveWork).toHaveBeenCalledWith('0'.repeat(64));
    });

    it('is a no-op when no pending tasks', async () => {
      await orchestrator.processNext();

      expect(custodyEngine.signReceive).not.toHaveBeenCalled();
      expect(custodyEngine.generateReceiveWork).not.toHaveBeenCalled();
      expect(mockClient.process).not.toHaveBeenCalled();
    });

    it('retries an account-info transport failure without signing an open block', async () => {
      const task = await receiveTaskStore.store.create({
        accountAddress,
        derivationIndex: 7,
        pendingBlockHash: 'account-info-failure',
        amountRaw: '123',
        status: 'pending',
        publishedAt: null,
        confirmedAt: null,
        failedAt: null,
        failReason: null,
        retryCount: 0,
      });
      mockClient.accountInfo.mockRejectedValue(new Error('rpc unavailable'));

      await orchestrator.processNext();

      expect(custodyEngine.signReceive).not.toHaveBeenCalled();
      expect(mockClient.process).not.toHaveBeenCalled();
      expect(await receiveTaskStore.store.get(task.id)).toMatchObject({ status: 'pending', retryCount: 1 });
    });

    it('reuses the persisted receive block after an ambiguous timeout and restart', async () => {
      const task = await receiveTaskStore.store.create({
        accountAddress,
        derivationIndex: 7,
        pendingBlockHash: 'restart-source-hash',
        amountRaw: '123',
        status: 'pending',
        publishedAt: null,
        confirmedAt: null,
        failedAt: null,
        failReason: null,
        retryCount: 0,
      });
      const intentStore = createInMemoryReceiveBlockIntentStore();
      let firstBlockJson: string | undefined;
      const firstClient = {
        ...createMockRpcClient(),
        process: vi.fn((blockJson: string) => {
          firstBlockJson = blockJson;
          return Promise.reject(new Error('request timed out'));
        }),
      };
      rpcPool = createMockRpcPool(firstClient);
      orchestrator = new ReceiveOrchestrator(receiveTaskStore.store, custodyEngine, rpcPool, emitEvent, undefined, intentStore, 1n);

      await orchestrator.processNext();
      expect(await receiveTaskStore.store.get(task.id)).toMatchObject({ status: 'processing' });

      let replayedBlockJson: string | undefined;
      const secondClient = {
        ...createMockRpcClient(),
        process: vi.fn((blockJson: string) => {
          replayedBlockJson = blockJson;
          return Promise.reject(new Error('Old block'));
        }),
        blockInfo: vi.fn().mockResolvedValue({ confirmed: false }),
      };
      rpcPool = createMockRpcPool(secondClient);
      orchestrator = new ReceiveOrchestrator(receiveTaskStore.store, custodyEngine, rpcPool, emitEvent, undefined, intentStore, 1n);

      await orchestrator.processNext();

      expect(secondClient.accountInfo).not.toHaveBeenCalled();
      expect(custodyEngine.signReceive).toHaveBeenCalledTimes(1);
      expect(replayedBlockJson).toBe(firstBlockJson);
      expect(await receiveTaskStore.store.get(task.id)).toMatchObject({ status: 'published', receiveBlockHash: 'published-hash' });
    });

    it('keeps an ambiguous process result recoverable with its processing lease and exact intent', async () => {
      const task = await receiveTaskStore.store.create({
        accountAddress,
        derivationIndex: 7,
        pendingBlockHash: 'retry-hash-1',
        amountRaw: '123',
        status: 'pending',
        publishedAt: null,
        confirmedAt: null,
        failedAt: null,
        failReason: null,
        retryCount: 0,
      });

      mockClient.process.mockRejectedValue(new Error('process failed'));

      await orchestrator.processNext();

      const updated = await receiveTaskStore.store.get(task.id);
      expect(updated?.status).toBe('processing');
      expect(updated?.retryCount).toBe(0);
      expect(emitEvent).not.toHaveBeenCalled();
    });

    it('does not terminally fail a receive after an ambiguous process error', async () => {
      const task = await receiveTaskStore.store.create({
        accountAddress,
        derivationIndex: 7,
        pendingBlockHash: 'retry-hash-3',
        amountRaw: '123',
        status: 'pending',
        publishedAt: null,
        confirmedAt: null,
        failedAt: null,
        failReason: null,
        retryCount: 2,
      });

      mockClient.process.mockRejectedValue(new Error('process failed hard'));

      await orchestrator.processNext();

      const updated = await receiveTaskStore.store.get(task.id);
      expect(updated?.status).toBe('processing');
      expect(updated?.retryCount).toBe(2);
      expect(updated?.failedAt).toBeNull();
      expect(emitEvent).not.toHaveBeenCalled();
    });

    it('does not process concurrently (processing flag guard)', async () => {
      await receiveTaskStore.store.create({
        accountAddress,
        derivationIndex: 7,
        pendingBlockHash: 'concurrent-hash',
        amountRaw: '123',
        status: 'pending',
        publishedAt: null,
        confirmedAt: null,
        failedAt: null,
        failReason: null,
        retryCount: 0,
      });

      const originalListByStatus = receiveTaskStore.store.listByStatus.bind(receiveTaskStore.store);
      const listStarted = createDeferred<void>();
      const releaseList = createDeferred<void>();
      const listSpy = vi.spyOn(receiveTaskStore.store, 'listByStatus').mockImplementation(async (status) => {
        listStarted.resolve();
        await releaseList.promise;
        return originalListByStatus(status);
      });

      const p1 = orchestrator.processNext();
      await listStarted.promise;
      const p2 = orchestrator.processNext();
      releaseList.resolve();

      await Promise.all([p1, p2]);

      expect(listSpy).toHaveBeenCalledTimes(2);
      expect(listSpy).toHaveBeenCalledWith('pending');
      expect(listSpy).toHaveBeenCalledWith('processing');
      expect(mockClient.process).toHaveBeenCalledTimes(1);
    });

    it('skips an account held by another worker so a different account can progress', async () => {
      await receiveTaskStore.store.create({
        accountAddress,
        derivationIndex: 7,
        pendingBlockHash: 'held-account-source',
        amountRaw: '10',
        status: 'pending',
        publishedAt: null,
        confirmedAt: null,
        failedAt: null,
        failReason: null,
        retryCount: 0,
      });
      const otherAddress = 'another-account-address';
      const otherTask = await receiveTaskStore.store.create({
        accountAddress: otherAddress,
        derivationIndex: 8,
        pendingBlockHash: 'other-account-source',
        amountRaw: '20',
        status: 'pending',
        publishedAt: null,
        confirmedAt: null,
        failedAt: null,
        failReason: null,
        retryCount: 0,
      });
      const leaseStore = createInMemoryAccountOperationLeaseStore();
      const now = new Date().toISOString();
      await leaseStore.acquire(accountAddress, 'another-worker', now, new Date(Date.now() + 60_000).toISOString());
      orchestrator = new ReceiveOrchestrator(
        receiveTaskStore.store,
        custodyEngine,
        rpcPool,
        emitEvent,
        new AccountOperationExecutor(leaseStore),
        undefined,
        1n,
      );

      await orchestrator.processNext();

      expect(mockClient.process).toHaveBeenCalledTimes(1);
      expect(await receiveTaskStore.store.getByPendingBlockHash('held-account-source')).toMatchObject({ status: 'pending' });
      expect(await receiveTaskStore.store.get(otherTask.id)).toMatchObject({ status: 'published' });
    });
  });

  describe('handleConfirmedReceive', () => {
    it("confirms by RaiFlow's receive block hash", async () => {
      const task = await receiveTaskStore.store.create({
        accountAddress,
        derivationIndex: 7,
        pendingBlockHash: 'source-send-hash',
        amountRaw: '123',
        status: 'published',
        receiveBlockHash: 'publish-hash',
        publishedAt: new Date().toISOString(),
        confirmedAt: null,
        failedAt: null,
        failReason: null,
        retryCount: 0,
      });

      await orchestrator.handleConfirmedReceive('publish-hash');

      const updated = await receiveTaskStore.store.get(task.id);
      expect(updated?.status).toBe('confirmed');
      expect(updated?.confirmedAt).toBeTruthy();
    });

    it('does not confuse source-send finality with receive-block finality', async () => {
      const task = await receiveTaskStore.store.create({
        accountAddress,
        derivationIndex: 7,
        pendingBlockHash: 'source-send-hash',
        amountRaw: '123',
        status: 'published',
        receiveBlockHash: 'own-receive-hash',
        publishedAt: new Date().toISOString(),
        confirmedAt: null,
        failedAt: null,
        failReason: null,
        retryCount: 0,
      });

      await orchestrator.handleConfirmedReceive('source-send-hash');

      expect(await receiveTaskStore.store.get(task.id)).toMatchObject({ status: 'published', confirmedAt: null });
    });

    it('is a no-op for unknown hash', async () => {
      await receiveTaskStore.store.create({
        accountAddress,
        derivationIndex: 7,
        pendingBlockHash: 'known-hash',
        amountRaw: '123',
        status: 'published',
        publishedAt: new Date().toISOString(),
        confirmedAt: null,
        failedAt: null,
        failReason: null,
        retryCount: 0,
      });

      await orchestrator.handleConfirmedReceive('unknown-hash');

      const known = await receiveTaskStore.store.getByPendingBlockHash('known-hash');
      expect(known?.status).toBe('published');
      expect(known?.confirmedAt).toBeNull();
    });

    it("is a no-op if task is not in 'published' status", async () => {
      const task = await receiveTaskStore.store.create({
        accountAddress,
        derivationIndex: 7,
        pendingBlockHash: 'pending-hash',
        amountRaw: '123',
        status: 'pending',
        publishedAt: null,
        confirmedAt: null,
        failedAt: null,
        failReason: null,
        retryCount: 0,
      });

      await orchestrator.handleConfirmedReceive('pending-hash');

      const updated = await receiveTaskStore.store.get(task.id);
      expect(updated?.status).toBe('pending');
      expect(updated?.confirmedAt).toBeNull();
    });
  });

  describe('handleConfirmedReceiveBlock', () => {
    it("updates a published task by RaiFlow's receive block hash and emits receive.confirmed", async () => {
      const task = await receiveTaskStore.store.create({
        accountAddress,
        derivationIndex: 7,
        pendingBlockHash: 'pending-send-hash',
        amountRaw: '123',
        status: 'published',
        receiveBlockHash: 'receive-block-hash',
        publishedAt: new Date().toISOString(),
        confirmedAt: null,
        failedAt: null,
        failReason: null,
        retryCount: 0,
      });

      await orchestrator.handleConfirmedReceiveBlock('receive-block-hash');

      expect(await receiveTaskStore.store.get(task.id)).toMatchObject({ status: 'confirmed', receiveBlockHash: 'receive-block-hash' });
      expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'receive.confirmed',
        data: expect.objectContaining({ pendingBlockHash: 'pending-send-hash', receiveBlockHash: 'receive-block-hash' }),
      }));
    });
  });
});
