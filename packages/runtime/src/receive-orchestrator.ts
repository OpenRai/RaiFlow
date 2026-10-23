import { randomUUID } from 'node:crypto';
import type { ReceiveTask, ReceiveTaskStore } from '@openrai/model';
import type { CustodyEngine } from '@openrai/custody';
import type { RpcPool } from '@openrai/rpc';
import type { ReceiveBlockIntentStore } from '@openrai/storage';
import { NanoAddress } from '@openrai/nano-core';
import { DEFAULT_MINIMUM_RECEIVE_AMOUNT_XNO, minimumReceiveAmountRaw } from '@openrai/config';
import { AccountOperationExecutor, AccountOperationLeaseLostError, createInMemoryAccountOperationLeaseStore } from './account-operation-executor.js';
import { createInMemoryReceiveBlockIntentStore } from './receive-block-intents.js';

type ReceivableEntry = {
  hash: string;
  amount: string;
};

export class ReceiveOrchestrator {
  private processing = false;

  constructor(
    private readonly receiveTaskStore: ReceiveTaskStore,
    private readonly custodyEngine: CustodyEngine,
    private readonly rpcPool: RpcPool,
    private readonly emitEvent: (event: unknown) => Promise<void>,
    private readonly accountOperations = new AccountOperationExecutor(createInMemoryAccountOperationLeaseStore()),
    private readonly receiveBlockIntentStore: ReceiveBlockIntentStore = createInMemoryReceiveBlockIntentStore(),
    private readonly minimumAmountRaw = BigInt(minimumReceiveAmountRaw(DEFAULT_MINIMUM_RECEIVE_AMOUNT_XNO)),
  ) {}

  enqueueReceivables(address: string, derivationIndex: number): Promise<void> {
    return this._enqueueReceivables(address, derivationIndex);
  }

  private async _enqueueReceivables(address: string, derivationIndex: number): Promise<void> {
    try {
      const client = this.rpcPool.getClient();
      const receivable = await client.accountsReceivable(address);
      const entries = this.normalizeReceivables(receivable);
      for (const entry of entries) {
        if (BigInt(entry.amount) < this.minimumAmountRaw) continue;
        try {
          await this.receiveTaskStore.create({
            accountAddress: address,
            derivationIndex,
            pendingBlockHash: entry.hash,
            amountRaw: entry.amount,
            status: 'pending',
            publishedAt: null,
            confirmedAt: null,
            failedAt: null,
            failReason: null,
            retryCount: 0,
          });
        } catch {
          // UNIQUE violation / already exists → idempotent no-op
        }
      }
    } catch {
      // RPC failure — silently ignore and retry later
    }
  }

  async processNext(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const [pending, processing] = await Promise.all([
        this.receiveTaskStore.listByStatus('pending'),
        this.receiveTaskStore.listByStatus('processing'),
      ]);
      const tasks = [...processing, ...pending].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const task of tasks) {
        // A saved signed block may already have reached the network. Finish
        // its recovery even if the configured minimum has since increased.
        if (BigInt(task.amountRaw) < this.minimumAmountRaw && !(await this.receiveBlockIntentStore.get(task.id))) continue;
        let acquired = false;
        try {
          await this.accountOperations.run(task.accountAddress, async ({ assertCurrent }) => {
            acquired = true;
            await this.receiveTaskStore.update(task.id, { status: 'processing' });
            await this.processTaskUnderLease(task, assertCurrent);
          });
        } catch (error) {
          if (!(error instanceof AccountOperationLeaseLostError)) throw error;
        }
        if (acquired) return;
      }
    } finally {
      this.processing = false;
    }
  }

  private async processTaskUnderLease(
    task: ReceiveTask,
    assertCurrent: () => Promise<void>,
  ): Promise<void> {
    let broadcastStarted = false;
    let repeatedWorkRejection = false;
    try {
      let intent = await this.receiveBlockIntentStore.get(task.id);
      if (!intent) {
        const client = this.rpcPool.getClient();
        // RpcClient returns undefined only for a genuinely unopened account.
        // Transport failures must retry; treating them as unopened can build a
        // conflicting open block for an account that already has a frontier.
        const accountInfo = await client.accountInfo(task.accountAddress);
        const frontier = accountInfo?.frontier ?? '';
        const resultingBalanceRaw = (
          BigInt(accountInfo?.balance ?? '0') + BigInt(task.amountRaw)
        ).toString();
        const signed = await this.custodyEngine.signReceive(
          task.accountAddress,
          task.pendingBlockHash,
          resultingBalanceRaw,
          frontier,
          task.derivationIndex,
        );
        const blockJson = JSON.parse(signed.contents) as Record<string, unknown>;
        blockJson['work'] = await this.custodyEngine.generateReceiveWork(
          frontier === '' ? NanoAddress.parse(task.accountAddress).publicKey : frontier,
        );
        await assertCurrent();
        intent = await this.receiveBlockIntentStore.createIfAbsent({
          taskId: task.id,
          blockHash: signed.hash,
          blockJson: JSON.stringify(blockJson),
          frontier,
          resultingBalanceRaw,
          createdAt: new Date().toISOString(),
        });
      }

      const client = this.rpcPool.getClient();
      const publish = async (blockJson: string): Promise<string> => {
        await assertCurrent();
        broadcastStarted = true;
        try {
          const result = await client.process(blockJson);
          if (result.hash !== intent!.blockHash) throw new Error('Published receive hash did not match the saved intent');
          return result.hash;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('Old block')) {
            const existing = await client.blockInfo(intent!.blockHash);
            if (existing) return intent!.blockHash;
          }
          throw error;
        }
      };

      let receiveBlockHash: string;
      try {
        receiveBlockHash = await publish(intent.blockJson);
      } catch (error) {
        if (error instanceof AccountOperationLeaseLostError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Block work is less than threshold')) throw error;

        const updatedBlock = JSON.parse(intent.blockJson) as Record<string, unknown>;
        updatedBlock['work'] = await this.custodyEngine.generateReceiveWork(
          intent.frontier === '' ? NanoAddress.parse(task.accountAddress).publicKey : intent.frontier,
        );
        const updatedBlockJson = JSON.stringify(updatedBlock);
        await assertCurrent();
        if (!(await this.receiveBlockIntentStore.updateWork(task.id, intent.blockHash, updatedBlockJson))) return;
        intent = { ...intent, blockJson: updatedBlockJson };
        try {
          receiveBlockHash = await publish(intent.blockJson);
        } catch (retryError) {
          const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
          if (retryMessage.includes('Block work is less than threshold')) repeatedWorkRejection = true;
          throw retryError;
        }
      }

      await assertCurrent();
      await this.receiveTaskStore.update(task.id, {
        status: 'published',
        receiveBlockHash,
        publishedAt: new Date().toISOString(),
      });
      await this.emitEvent({
        id: randomUUID(),
        type: 'receive.published',
        timestamp: new Date().toISOString(),
        data: { receive: { ...task, status: 'published', receiveBlockHash } },
        resourceId: task.id,
        resourceType: 'account',
      });
    } catch (err) {
      if (err instanceof AccountOperationLeaseLostError) throw err;
      await assertCurrent();
      if (broadcastStarted && !repeatedWorkRejection) return;
      const retryCount = (task.retryCount ?? 0) + 1;
      if (retryCount >= 3) {
        await this.receiveTaskStore.update(task.id, {
          status: 'failed',
          failedAt: new Date().toISOString(),
          failReason: err instanceof Error ? err.message : String(err),
          retryCount,
        });
        try {
          await this.emitEvent({
            id: randomUUID(),
            type: 'receive.failed',
            timestamp: new Date().toISOString(),
            data: { task: { ...task, retryCount, status: 'failed' } },
            resourceId: task.id,
            resourceType: 'receive_task',
          });
        } catch {
          // swallow event emission failures
        }
      } else {
        await this.receiveTaskStore.update(task.id, {
          status: 'pending',
          retryCount,
        });
      }
    }
  }

  async handleConfirmedReceive(blockHash: string): Promise<void> {
    return this.handleConfirmedReceiveBlock(blockHash);
  }

  /** Mark RaiFlow's own receive/open block confirmed, then emit a durable event. */
  async handleConfirmedReceiveBlock(blockHash: string): Promise<void> {
    const published = await this.receiveTaskStore.listByStatus('published');
    const task = published.find((candidate) => candidate.receiveBlockHash === blockHash);
    if (!task) return;
    const updated = await this.receiveTaskStore.update(task.id, {
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
    });
    await this.emitEvent({
      id: randomUUID(),
      type: 'receive.confirmed',
      timestamp: new Date().toISOString(),
      data: { receive: updated, pendingBlockHash: updated.pendingBlockHash, receiveBlockHash: blockHash },
      resourceId: task.id,
      resourceType: 'account',
    });
  }

  private normalizeReceivables(receivable: unknown): ReceivableEntry[] {
    if (Array.isArray(receivable)) {
      return receivable
        .filter((row): row is { hash: string; amount: string } =>
          typeof row === 'object' &&
          row !== null &&
          typeof (row as { hash?: unknown }).hash === 'string' &&
          typeof (row as { amount?: unknown }).amount === 'string',
        )
        .map((row) => ({ hash: row.hash, amount: row.amount }));
    }

    if (typeof receivable === 'object' && receivable !== null) {
      const blocks = (receivable as { blocks?: unknown }).blocks;
      if (blocks && typeof blocks === 'object') {
        return Object.entries(blocks as Record<string, unknown>).map(([hash, info]) => {
          const amount =
            typeof info === 'object' &&
            info !== null &&
            'amount' in info &&
            typeof (info as { amount?: unknown }).amount === 'string'
              ? (info as { amount: string }).amount
              : String(info);
          return { hash, amount };
        });
      }
    }

    return [];
  }
}
