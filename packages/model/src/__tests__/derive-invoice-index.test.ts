import { describe, expect, it } from 'vitest';
import {
  deriveInvoiceIndex,
  deriveManagedIndex,
  MANAGED_DERIVATION_START,
} from '@openrai/model';

describe('deriveInvoiceIndex', () => {
  it('same inputs always produce same output (determinism)', () => {
    const accountKey = 'acct:merchant-123';
    const invoiceKey = 'inv:order-456';
    const startIndex = 0;

    const first = deriveInvoiceIndex(accountKey, invoiceKey, startIndex);
    const second = deriveInvoiceIndex(accountKey, invoiceKey, startIndex);

    expect(second).toBe(first);
  });

  it('different accountKey → different index', () => {
    const invoiceKey = 'inv:order-456';
    const startIndex = 0;

    const a = deriveInvoiceIndex('acct:merchant-123', invoiceKey, startIndex);
    const b = deriveInvoiceIndex('acct:merchant-999', invoiceKey, startIndex);

    expect(b).not.toBe(a);
  });

  it('different invoiceKey → different index', () => {
    const accountKey = 'acct:merchant-123';
    const startIndex = 0;

    const a = deriveInvoiceIndex(accountKey, 'inv:order-456', startIndex);
    const b = deriveInvoiceIndex(accountKey, 'inv:order-789', startIndex);

    expect(b).not.toBe(a);
  });

  it("null invoiceKey and empty string invoiceKey produce same result (both map to '')", () => {
    const accountKey = 'acct:merchant-123';
    const startIndex = 0;

    const withNull = deriveInvoiceIndex(accountKey, null, startIndex);
    const withEmpty = deriveInvoiceIndex(accountKey, '', startIndex);

    expect(withEmpty).toBe(withNull);
  });

  it('result is within [startIndex, startIndex + 2^27) range', () => {
    const startIndex = 4_000_000;
    const result = deriveInvoiceIndex('acct:merchant-123', 'inv:order-456', startIndex);
    const maxExclusive = startIndex + (2 ** 27);

    expect(result).toBeGreaterThanOrEqual(startIndex);
    expect(result).toBeLessThan(maxExclusive);
  });

  it('startIndex offset is applied correctly', () => {
    const accountKey = 'acct:merchant-123';
    const invoiceKey = 'inv:order-456';

    const baseStart = 0;
    const offsetStart = 9_000_000;
    const base = deriveInvoiceIndex(accountKey, invoiceKey, baseStart);
    const shifted = deriveInvoiceIndex(accountKey, invoiceKey, offsetStart);

    expect(shifted - base).toBe(offsetStart - baseStart);
  });
});

describe('deriveManagedIndex', () => {
  it('is deterministic and confined to the managed high-bit namespace', () => {
    const first = deriveManagedIndex('merchant:treasury');
    expect(deriveManagedIndex('merchant:treasury')).toBe(first);
    expect(first).toBeGreaterThanOrEqual(MANAGED_DERIVATION_START);
    expect(first).toBeLessThan(2 ** 32);
  });

  it('does not overlap invoice indices', () => {
    const invoice = deriveInvoiceIndex('merchant', 'invoice', 0);
    const managed = deriveManagedIndex('merchant');
    expect(invoice).toBeLessThan(MANAGED_DERIVATION_START);
    expect(managed).toBeGreaterThanOrEqual(MANAGED_DERIVATION_START);
  });
});
