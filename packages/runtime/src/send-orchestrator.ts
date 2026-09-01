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

const WORK_REJECTION_MESSAGE = 'Block work is less than threshold';

export class SendOrchestrator {
  private timer: ReturnType<typeof setInterval> | undefined;
  private processing = false;

  constructor(
    private readonly sendStore: SendStore,
    private readonly accountStore: AccountStore,
    private readonly custodyEngine: CustodyEngine,
    private readonly rpcPool: RpcPool,
    private readonly emitEvent: (event: RaiFlowEvent) => Promise<void>,
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
      const queued = await this.sendStore.listByStatus('queued');
      for (const send of queued) {
        await this.publishSend(send);
      }
    } finally {
      this.processing = false;
    }
  }

  private async publishSend(send: Send): Promise<void> {
    try {
      // 1. Fetch account info (frontier, balance, representative)
      const account = await this.accountStore.get(send.accountId);
      if (!account) throw new Error('Account not found');

      const client = this.rpcPool.getClient();
      let info = await client.accountInfo(account.address);
      if (!info) {
        // Unopened account — use zero state
        info = {
          frontier: '0000000000000000000000000000000000000000000000000000000000000000',
          balance: '0',
          representative: account.representative ?? '',
          blockCount: 0,
        };
      }

      const currentBalanceRaw = info.balance ?? '0';
      if (BigInt(currentBalanceRaw) < BigInt(send.amountRaw)) {
        throw new Error('Insufficient balance');
      }

      // 2. Compute new balance (current balance - send amount)
      const newBalanceRaw = (BigInt(currentBalanceRaw) - BigInt(send.amountRaw)).toString();
      const frontier = info.frontier ?? '0000000000000000000000000000000000000000000000000000000000000000';

      // 3. Sign the block
      const signed = await this.custodyEngine.signSend(
        account.address,
        send.destination,
        newBalanceRaw, // balance AFTER this send
        frontier,
        account.derivationIndex ?? undefined,
      );

      // 4. Generate work
      const work = await this.custodyEngine.generateWork(frontier);

      // 5. Build final block JSON with work included
      const blockJson = JSON.parse(signed.contents);
      blockJson.work = work;

      // 6. Publish to network (with retry-once for work rejection)
      const publish = async () => {
        try {
          return await client.process(JSON.stringify(blockJson));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A crash after a successful process call can leave the send queued.
          // Re-publishing the exact deterministic block returns "Old block";
          // treating that as success closes the ambiguous-commit window.
          if (message.includes('Old block')) return { hash: signed.hash };
          throw error;
        }
      };
      let result;
      try {
        result = await publish();
      } catch (processErr) {
        const message = processErr instanceof Error ? processErr.message : String(processErr);
        if (!message.includes(WORK_REJECTION_MESSAGE)) throw processErr;

        // Work was rejected — regenerate and retry once
        const newWork = await this.custodyEngine.generateWork(frontier);
        blockJson.work = newWork;
        result = await publish();
      }

      // 7. Update send to published
      const published = await this.sendStore.update(send.id, {
        status: 'published',
        blockHash: result.hash,
        publishedAt: new Date().toISOString(),
      });

      // 8. Update account frontier
      await this.accountStore.update(account.id, {
        frontier: result.hash,
        balanceRaw: newBalanceRaw,
      });

      await this.emitEvent({
        id: randomUUID(),
        type: 'send.published',
        timestamp: new Date().toISOString(),
        data: { send: published },
        resourceId: published.id,
        resourceType: 'send',
      });
      void this.confirmPublishedSend(published.id, result.hash);
    } catch (err) {
      // On failure, mark as failed and emit event
      const failed = await this.sendStore.update(send.id, {
        status: 'failed',
      });

      await this.emitEvent({
        id: randomUUID(),
        type: 'send.failed',
        timestamp: new Date().toISOString(),
        data: { send: failed, reason: err instanceof Error ? err.message : String(err) },
        resourceId: failed.id,
        resourceType: 'send',
      });
    }
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
