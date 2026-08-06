import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReceiveTask, ReceiveTaskStore } from '@openrai/model';
import type { CustodyEngine } from '@openrai/custody';
import type { RpcPool } from '@openrai/rpc';
import { ReceiveOrchestrator } from '../receive-orchestrator.js';

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
    signReceive: vi.fn().mockResolvedValue({ contents: JSON.stringify({ type: 'state' }) }),
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
    orchestrator = new ReceiveOrchestrator(receiveTaskStore.store, custodyEngine, rpcPool, emitEvent);
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

    it("on failure, increments retryCount and keeps status 'pending' (retry < 3)", async () => {
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
      expect(updated?.status).toBe('pending');
      expect(updated?.retryCount).toBe(1);
      expect(emitEvent).not.toHaveBeenCalled();
    });

    it("on 3rd failure, marks status 'failed' and calls emitEvent with 'receive.failed'", async () => {
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
      expect(updated?.status).toBe('failed');
      expect(updated?.retryCount).toBe(3);
      expect(updated?.failedAt).toBeTruthy();
      expect(updated?.failReason).toContain('process failed hard');
      expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'receive.failed' }));
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

      expect(listSpy).toHaveBeenCalledTimes(1);
      expect(mockClient.process).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleConfirmedReceive', () => {
    it("updates a 'published' task to 'confirmed'", async () => {
      const task = await receiveTaskStore.store.create({
        accountAddress,
        derivationIndex: 7,
        pendingBlockHash: 'publish-hash',
        amountRaw: '123',
        status: 'published',
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
});
