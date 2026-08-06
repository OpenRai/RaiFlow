import { randomUUID } from 'node:crypto';
import type { ReceiveTaskStore } from '@openrai/model';
import type { CustodyEngine } from '@openrai/custody';
import type { RpcPool } from '@openrai/rpc';
import { NanoAddress } from '@openrai/nano-core';

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
  ) {}

  enqueueReceivables(address: string, derivationIndex: number): void {
    void this._enqueueReceivables(address, derivationIndex);
  }

  private async _enqueueReceivables(address: string, derivationIndex: number): Promise<void> {
    try {
      const client = this.rpcPool.getClient();
      const receivable = await client.accountsReceivable(address);
      const entries = this.normalizeReceivables(receivable);
      for (const entry of entries) {
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
      const pending = await this.receiveTaskStore.listByStatus('pending');
      if (pending.length === 0) return;

      const task = pending[0]!;
      await this.receiveTaskStore.update(task.id, { status: 'processing' });

      try {
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

        const work = await this.custodyEngine.generateReceiveWork(
          frontier === '' ? NanoAddress.parse(task.accountAddress).publicKey : frontier,
        );

        const blockJson = JSON.parse(signed.contents) as Record<string, unknown>;
        blockJson['work'] = work;
        try {
          await client.process(JSON.stringify(blockJson));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes('Old block')) throw error;
        }

        await this.receiveTaskStore.update(task.id, {
          status: 'published',
          publishedAt: new Date().toISOString(),
        });
      } catch (err) {
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
    } finally {
      this.processing = false;
    }
  }

  async handleConfirmedReceive(blockHash: string): Promise<void> {
    const task = await this.receiveTaskStore.getByPendingBlockHash(blockHash).catch(() => undefined);
    if (!task) return;
    if (task.status !== 'published') return;
    await this.receiveTaskStore.update(task.id, {
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
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
