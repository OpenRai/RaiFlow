// @openrai/runtime — Background send orchestrator

import { randomUUID } from 'node:crypto';
import type {
  AccountStore,
  RaiFlowEvent,
  Send,
  SendStore,
} from '@openrai/model';
import type { CustodyEngine } from '@openrai/custody';
import type { RpcPool } from '@openrai/rpc';
import type { SendBlockIntent, SendBlockIntentStore } from '@openrai/storage';
import { AccountOperationExecutor, AccountOperationLeaseLostError, createInMemoryAccountOperationLeaseStore } from './account-operation-executor.js';
import { createInMemorySendBlockIntentStore } from './send-block-intents.js';

const WORK_REJECTION_MESSAGE = 'Block work is less than threshold';

export class SendOrchestrator {
  private timer: ReturnType<typeof setInterval> | undefined;
  private processing = false;
  private readonly confirmingSends = new Set<string>();

  private async resolveSource(send: Send): Promise<{
    address: string;
    derivationIndex: number | undefined;
    account?: NonNullable<Awaited<ReturnType<AccountStore['get']>>>;
  }> {
    if (send.source.type === 'invoice') {
      return { address: send.source.address, derivationIndex: send.source.derivationIndex };
    }
    const account = await this.accountStore.get(send.source.accountId);
    if (!account || account.type !== 'managed') throw new Error('Managed source account not found');
    return {
      address: account.address,
      derivationIndex: account.derivationIndex ?? undefined,
      account,
    };
  }

  constructor(
    private readonly sendStore: SendStore,
    private readonly accountStore: AccountStore,
    private readonly custodyEngine: CustodyEngine,
    private readonly rpcPool: RpcPool,
    private readonly emitEvent: (event: RaiFlowEvent) => Promise<void>,
    private readonly accountOperations = new AccountOperationExecutor(createInMemoryAccountOperationLeaseStore()),
    private readonly sendBlockIntentStore: SendBlockIntentStore = createInMemorySendBlockIntentStore(),
    private readonly onConfirmed?: (send: Send) => Promise<void>,
  ) {}

  start(intervalMs = 5000): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const [queued, published] = await Promise.all([
        this.sendStore.listByStatus('queued'),
        this.sendStore.listByStatus('published'),
      ]);
      for (const send of published) {
        if (send.blockHash) this.startConfirmation(send.id, send.blockHash);
      }
      for (const send of queued) {
        await this.publishSend(send);
      }
    } finally {
      this.processing = false;
    }
  }

  private async publishSend(send: Send): Promise<void> {
    try {
      const source = await this.resolveSource(send);

      await this.accountOperations.run(source.address, async ({ assertCurrent }) => {
        try {
          await this.publishSendUnderLease(send, source, assertCurrent);
        } catch (err) {
          if (err instanceof AccountOperationLeaseLostError) throw err;
          // Once a signed intent exists, any storage/provider failure is
          // ambiguous and must leave it queued for exact-intent recovery.
        }
      });
    } catch (err) {
      if (err instanceof AccountOperationLeaseLostError) return;
      // Lease contention is normal. An account lookup failure is retryable too.
    }
  }

  private async publishSendUnderLease(
    send: Send,
    source: Awaited<ReturnType<SendOrchestrator['resolveSource']>>,
    assertCurrent: () => Promise<void>,
  ): Promise<void> {
    let intent = await this.sendBlockIntentStore.get(send.id);
    if (!intent) {
      try {
        const client = this.rpcPool.getClient();
        const info = await client.accountInfo(source.address);
        const balance = info?.balance ?? '0';
        if (BigInt(balance) < BigInt(send.amountRaw)) throw new Error('Insufficient balance');
        const resultingBalanceRaw = (BigInt(balance) - BigInt(send.amountRaw)).toString();
        const frontier = info?.frontier ?? '0'.repeat(64);
        const signed = await this.custodyEngine.signSend(
          source.address,
          send.destination,
          resultingBalanceRaw,
          frontier,
          source.derivationIndex,
        );
        const blockJson = JSON.parse(signed.contents) as Record<string, unknown>;
        blockJson['work'] = await this.custodyEngine.generateWork(frontier);
        await assertCurrent();
        intent = await this.sendBlockIntentStore.createIfAbsent({
          sendId: send.id,
          blockHash: signed.hash,
          blockJson: JSON.stringify(blockJson),
          frontier,
          resultingBalanceRaw,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        // No block has been broadcast. Only deterministic preparation failures
        // are terminal; provider/storage failures remain queued for retry.
        if (error instanceof Error && error.message === 'Insufficient balance') {
          await assertCurrent();
          const failed = await this.sendStore.update(send.id, { status: 'failed' });
          await this.emitEvent({
            id: randomUUID(),
            type: 'send.failed',
            timestamp: new Date().toISOString(),
            data: { send: failed, reason: error.message },
            resourceId: failed.id,
            resourceType: 'send',
          });
        }
        return;
      }
    }

    const client = this.rpcPool.getClient();
    let blockJson = intent.blockJson;
    let acceptedHash: string;
    const publish = async (): Promise<string> => {
      await assertCurrent();
      try {
        const result = await client.process(blockJson);
        if (result.hash !== intent!.blockHash) throw new Error('Published block hash did not match the saved send intent');
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

    try {
      acceptedHash = await publish();
    } catch (error) {
      if (error instanceof AccountOperationLeaseLostError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(WORK_REJECTION_MESSAGE)) return;

      try {
        const updatedBlock = JSON.parse(blockJson) as Record<string, unknown>;
        updatedBlock['work'] = await this.custodyEngine.generateWork(intent.frontier);
        blockJson = JSON.stringify(updatedBlock);
        await assertCurrent();
        if (!(await this.sendBlockIntentStore.updateWork(send.id, intent.blockHash, blockJson))) return;
        acceptedHash = await publish();
      } catch (retryError) {
        if (retryError instanceof AccountOperationLeaseLostError) throw retryError;
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        if (retryMessage.includes(WORK_REJECTION_MESSAGE)) {
          await assertCurrent();
          const failed = await this.sendStore.update(send.id, { status: 'failed' });
          await this.emitEvent({
            id: randomUUID(),
            type: 'send.failed',
            timestamp: new Date().toISOString(),
            data: { send: failed, reason: retryMessage },
            resourceId: failed.id,
            resourceType: 'send',
          });
        }
        return;
      }
    }

    try {
      await assertCurrent();
      const published = await this.sendStore.update(send.id, {
        status: 'published',
        blockHash: acceptedHash,
        publishedAt: new Date().toISOString(),
      });
      if (source.account) {
        await this.accountStore.update(source.account.id, {
          frontier: acceptedHash,
          balanceRaw: intent.resultingBalanceRaw,
        });
      }
      await this.emitEvent({
        id: randomUUID(),
        type: 'send.published',
        timestamp: new Date().toISOString(),
        data: { send: published },
        resourceId: published.id,
        resourceType: 'send',
      });
    } catch {
      // The exact intent remains durable. The next tick can replay it and
      // repair send state without constructing a second transfer.
      return;
    }
    this.startConfirmation(send.id, acceptedHash);
  }

  private startConfirmation(sendId: string, blockHash: string): void {
    if (this.confirmingSends.has(sendId)) return;
    this.confirmingSends.add(sendId);
    void this.confirmPublishedSend(sendId, blockHash).finally(() => this.confirmingSends.delete(sendId));
  }

  /** Reconcile send confirmation even when no WebSocket watcher is configured. */
  private async confirmPublishedSend(sendId: string, blockHash: string): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const info = await this.rpcPool.getClient().blockInfo(blockHash);
        if (info?.confirmed) {
          const current = await this.sendStore.get(sendId);
          if (current?.status !== 'confirmed') {
            const confirmed = await this.sendStore.update(sendId, {
              status: 'confirmed',
              confirmedAt: new Date().toISOString(),
            });
            await this.emitEvent({
              id: randomUUID(),
              type: 'send.confirmed',
              timestamp: new Date().toISOString(),
              data: { send: confirmed },
              resourceId: confirmed.id,
              resourceType: 'send',
            });
            await this.onConfirmed?.(confirmed);
          } else {
            await this.onConfirmed?.(current);
          }
          return;
        }
      } catch {
        // Keep polling through brief provider propagation/rate-limit failures.
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}
