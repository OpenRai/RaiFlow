import { randomUUID } from 'node:crypto';
import type { AccountOperationLease, AccountOperationLeaseStore } from '@openrai/storage';

export class AccountOperationLeaseLostError extends Error {
  constructor(accountAddress: string) {
    super(`Account operation lease lost for ${accountAddress}`);
    this.name = 'AccountOperationLeaseLostError';
  }
}

export interface AccountOperationContext {
  lease: AccountOperationLease;
  assertCurrent(): Promise<void>;
}

/** Runs one account-chain write while holding and renewing its durable lease. */
export class AccountOperationExecutor {
  constructor(
    private readonly leaseStore: AccountOperationLeaseStore,
    private readonly leaseDurationMs = 30_000,
  ) {}

  async run<T>(accountAddress: string, operation: (context: AccountOperationContext) => Promise<T>): Promise<T | undefined> {
    const now = new Date();
    const ownerId = randomUUID();
    const lease = await this.leaseStore.acquire(
      accountAddress,
      ownerId,
      now.toISOString(),
      new Date(now.getTime() + this.leaseDurationMs).toISOString(),
    );
    if (!lease) return undefined;

    let lost = false;
    let renewing: Promise<void> | undefined;
    const renew = async (): Promise<void> => {
      if (renewing || lost) return;
      renewing = (async () => {
        const current = new Date();
        const renewed = await this.leaseStore.renew(
          lease,
          current.toISOString(),
          new Date(current.getTime() + this.leaseDurationMs).toISOString(),
        );
        if (!renewed) lost = true;
      })().finally(() => { renewing = undefined; });
      await renewing;
    };
    const timer = setInterval(() => { void renew().catch(() => { lost = true; }); }, Math.max(100, Math.floor(this.leaseDurationMs / 3)));
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as NodeJS.Timeout).unref();
    }

    const assertCurrent = async (): Promise<void> => {
      if (lost || !(await this.leaseStore.isCurrent(lease, new Date().toISOString()))) {
        lost = true;
        throw new AccountOperationLeaseLostError(accountAddress);
      }
    };

    try {
      await assertCurrent();
      const result = await operation({ lease, assertCurrent });
      await assertCurrent();
      return result;
    } finally {
      clearInterval(timer);
      await renewing?.catch(() => { lost = true; });
      await this.leaseStore.release(lease);
    }
  }
}

/** Test/default runtime store; production wiring uses SQLite. */
export function createInMemoryAccountOperationLeaseStore(): AccountOperationLeaseStore {
  const leases = new Map<string, AccountOperationLease>();
  const tokens = new Map<string, number>();
  return {
    async acquire(accountAddress, ownerId, now, expiresAt) {
      const existing = leases.get(accountAddress);
      if (existing && existing.expiresAt > now) return undefined;
      const fencingToken = (tokens.get(accountAddress) ?? 0) + 1;
      tokens.set(accountAddress, fencingToken);
      const lease = { accountAddress, ownerId, fencingToken, expiresAt };
      leases.set(accountAddress, lease);
      return lease;
    },
    async renew(lease, now, expiresAt) {
      const current = leases.get(lease.accountAddress);
      if (!current || current.ownerId !== lease.ownerId || current.fencingToken !== lease.fencingToken || current.expiresAt <= now) return false;
      leases.set(lease.accountAddress, { ...current, expiresAt });
      return true;
    },
    async isCurrent(lease, now) {
      const current = leases.get(lease.accountAddress);
      return Boolean(current && current.ownerId === lease.ownerId && current.fencingToken === lease.fencingToken && current.expiresAt > now);
    },
    async release(lease) {
      const current = leases.get(lease.accountAddress);
      if (current?.ownerId === lease.ownerId && current.fencingToken === lease.fencingToken) {
        leases.set(lease.accountAddress, { ...current, expiresAt: '1970-01-01T00:00:00.000Z' });
      }
    },
  };
}
