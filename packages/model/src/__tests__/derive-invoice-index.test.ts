import { describe, expect, it } from 'vitest';
import {
  deriveManagedIndex,
  MANAGED_DERIVATION_START,
} from '@openrai/model';

describe('deriveManagedIndex', () => {
  it('is deterministic and confined to the managed high-bit namespace', () => {
    const first = deriveManagedIndex('merchant:treasury');
    expect(deriveManagedIndex('merchant:treasury')).toBe(first);
    expect(first).toBeGreaterThanOrEqual(MANAGED_DERIVATION_START);
    expect(first).toBeLessThan(2 ** 32);
  });

  it('stays in the managed namespace above invoice start indices', () => {
    const managed = deriveManagedIndex('merchant');
    expect(managed).toBeGreaterThanOrEqual(MANAGED_DERIVATION_START);
  });
});
