import { describe, it, expect } from 'vitest';
import { xnoToRaw } from '../runtime.js';
import {
  ONE_XNO,
  HALF_XNO,
  TEST_ACCOUNT_2,
  createTestRuntime,
  createTestInvoice,
  makeBlock,
} from './helpers.js';

describe('createInvoice', () => {
  it('derives payAddress and defaults status/amount fields', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({ expectedAmountRaw: ONE_XNO });

    expect(invoice.status).toBe('open');
    expect(invoice.receivedAmountRaw).toBe('0');
    expect(invoice.payAddress.startsWith('nano_') || invoice.payAddress.startsWith('xrb_')).toBe(true);
  });

  it('is idempotent by key and returns the original invoice', async () => {
    const { runtime } = createTestRuntime();
    const inv1 = await runtime.createInvoice({ expectedAmountRaw: ONE_XNO }, 'inv-create-1');
    const inv2 = await runtime.createInvoice({ expectedAmountRaw: ONE_XNO }, 'inv-create-1');

    expect(inv1.id).toBe(inv2.id);
    expect(inv1.payAddress).toBe(inv2.payAddress);
  });
});

describe('cancelInvoice', () => {
  it('cancels an open invoice', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await createTestInvoice(runtime);

    const canceled = await runtime.cancelInvoice(invoice.id);

    expect(canceled.status).toBe('canceled');
    expect(canceled.canceledAt).toBeTruthy();
  });

  it('is idempotent by key', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await createTestInvoice(runtime);

    const first = await runtime.cancelInvoice(invoice.id, 'inv-cancel-1');
    const second = await runtime.cancelInvoice(invoice.id, 'inv-cancel-1');

    expect(first.id).toBe(second.id);
    expect(second.status).toBe('canceled');
  });
});

describe('handleConfirmedBlock', () => {
  it('records payment and completes invoice on full amount', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await createTestInvoice(runtime);

    await runtime.handleConfirmedBlock(makeBlock({ recipientAccount: invoice.payAddress, amountRaw: ONE_XNO }));

    const payments = await runtime.getPaymentsByInvoice(invoice.id);
    const updated = await runtime.getInvoice(invoice.id);

    expect(payments).toHaveLength(1);
    expect(payments[0]!.status).toBe('confirmed');
    expect(updated!.status).toBe('completed');
    expect(updated!.receivedAmountRaw).toBe(ONE_XNO);
  });

  it('emits canonical invoice payment events', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    const invoice = await createTestInvoice(runtime);

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: invoice.payAddress,
      senderAccount: TEST_ACCOUNT_2,
      amountRaw: ONE_XNO,
    }));

    const types = deliveredEvents.map((e) => e.event.type);
    expect(types).toContain('invoice.payment_received');
    expect(types).toContain('invoice.payment_confirmed');
    expect(types).toContain('invoice.completed');
  });

  it('is idempotent for duplicate block hash', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    const invoice = await createTestInvoice(runtime);

    const block = makeBlock({ recipientAccount: invoice.payAddress, amountRaw: HALF_XNO });
    await runtime.handleConfirmedBlock(block);
    await runtime.handleConfirmedBlock(block);

    const payments = await runtime.getPaymentsByInvoice(invoice.id);
    const confirmedEvents = deliveredEvents.filter((e) => e.event.type === 'invoice.payment_confirmed');
    expect(payments).toHaveLength(1);
    expect(confirmedEvents).toHaveLength(1);
  });
});

describe('global event polling', () => {
  it('returns paginated canonical events', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await createTestInvoice(runtime);
    await runtime.handleConfirmedBlock(makeBlock({ recipientAccount: invoice.payAddress, amountRaw: ONE_XNO }));

    const firstPage = await runtime.listEvents({ limit: 2 });
    expect(firstPage.data.length).toBeLessThanOrEqual(2);
    expect(firstPage.data.length).toBeGreaterThan(0);
    expect(firstPage.nextCursor === null || typeof firstPage.nextCursor === 'string').toBe(true);

    const secondPage = await runtime.listEvents({ limit: 2, after: firstPage.nextCursor ?? undefined });
    expect(Array.isArray(secondPage.data)).toBe(true);
  });
});

describe('xnoToRaw', () => {
  it('converts valid values and rejects invalid values', () => {
    expect(xnoToRaw('1')).toBe('1000000000000000000000000000000');
    expect(xnoToRaw('0.001')).toBe('1000000000000000000000000000');
    expect(() => xnoToRaw('')).toThrow('Invalid XNO amount');
    expect(() => xnoToRaw('0')).toThrow('must be greater than zero');
  });
});
