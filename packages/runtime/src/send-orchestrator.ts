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

export class SendOrchestrator {
  private timer: ReturnType<typeof setInterval> | undefined;

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

  private async tick(): Promise<void> {
    const queued = await this.sendStore.listByStatus('queued');
    for (const send of queued) {
      await this.publishSend(send);
    }
  }

  private async publishSend(send: Send): Promise<void> {
    try {
      // 1. Fetch account info (frontier, balance, representative)
      const account = await this.accountStore.get(send.accountId);
      if (!account) throw new Error('Account not found');

      const client = this.rpcPool.getClient();
      let info;
      try {
        info = await client.accountInfo(account.address);
      } catch {
        // Treat as unopened account
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
      const work = await this.custodyEngine.generateWork(signed.hash);

      // 5. Build final block JSON with work included
      const blockJson = JSON.parse(signed.contents);
      blockJson.work = work;

      // 6. Publish to network
      const result = await client.process(JSON.stringify(blockJson));

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
}
