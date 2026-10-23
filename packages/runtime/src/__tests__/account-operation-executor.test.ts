import { describe, expect, it } from 'vitest';
import { AccountOperationExecutor, createInMemoryAccountOperationLeaseStore } from '../account-operation-executor.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('AccountOperationExecutor', () => {
  it('allows only one active operation per account and preserves independent account progress', async () => {
    const executor = new AccountOperationExecutor(createInMemoryAccountOperationLeaseStore());
    const held = deferred();
    const started = deferred();
    const first = executor.run('nano_a', async () => {
      started.resolve();
      await held.promise;
      return 'first';
    });

    await started.promise;
    const duplicate = await executor.run('nano_a', async () => 'duplicate');
    const other = await executor.run('nano_b', async () => 'other');
    expect(duplicate).toBeUndefined();
    expect(other).toBe('other');

    held.resolve();
    expect(await first).toBe('first');
  });

  it('rejects a stale fencing token after another owner takes over', async () => {
    const leaseStore = createInMemoryAccountOperationLeaseStore();
    const executor = new AccountOperationExecutor(leaseStore, 30);
    let assertCurrent: (() => Promise<void>) | undefined;
    await executor.run('nano_c', async (context) => { assertCurrent = context.assertCurrent; });
    await expect(assertCurrent?.()).rejects.toThrow('lease lost');
  });
});
