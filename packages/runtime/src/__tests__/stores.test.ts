// @openrai/runtime — Store unit tests

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Invoice, Payment } from '@openrai/model';
import {
  createInvoiceStore,
  createPaymentStore,
  createEventStore,
} from '../stores.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ONE_XNO = '1000000000000000000000000000000';
const TEST_ACCOUNT = 'nano_1testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: randomUUID(),
    status: 'open',
    currency: 'XNO',
    expectedAmountRaw: ONE_XNO,
    confirmedAmountRaw: '0',
    recipientAccount: TEST_ACCOUNT,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePayment(overrides: Partial<Payment> & { invoiceId: string }): Payment {
  const { invoiceId, ...rest } = overrides;
  return {
    id: randomUUID(),
    invoiceId,
    status: 'confirmed',
    currency: 'XNO',
    amountRaw: ONE_XNO,
    recipientAccount: TEST_ACCOUNT,
    sendBlockHash: `hash_${randomUUID()}`,
    confirmedAt: new Date().toISOString(),
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// InvoiceStore
// ---------------------------------------------------------------------------

describe('InvoiceStore', () => {
  it('create and get', async () => {
    const store = createInvoiceStore();
    const invoice = makeInvoice();
    await store.create(invoice);

    const fetched = await store.get(invoice.id);
    expect(fetched).toEqual(invoice);
  });

  it('get returns undefined for unknown id', async () => {
    const store = createInvoiceStore();
    const result = await store.get('non-existent');
    expect(result).toBeUndefined();
  });

  it('idempotency key deduplication returns same invoice', async () => {
    const store = createInvoiceStore();
    const inv1 = makeInvoice();
    const inv2 = makeInvoice();

    await store.create(inv1, 'key-1');
    const result = await store.create(inv2, 'key-1');

    expect(result.id).toBe(inv1.id);
  });

  it('no idempotency key creates separate invoices', async () => {
    const store = createInvoiceStore();
    const inv1 = makeInvoice();
    const inv2 = makeInvoice();

    await store.create(inv1);
    await store.create(inv2);

    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it('list returns all invoices without filter', async () => {
    const store = createInvoiceStore();
    await store.create(makeInvoice({ status: 'open' }));
    await store.create(makeInvoice({ status: 'completed' }));
    await store.create(makeInvoice({ status: 'canceled' }));

    const all = await store.list();
    expect(all).toHaveLength(3);
  });

  it('list filters by status', async () => {
    const store = createInvoiceStore();
    await store.create(makeInvoice({ status: 'open' }));
    await store.create(makeInvoice({ status: 'open' }));
    await store.create(makeInvoice({ status: 'completed' }));

    const open = await store.list({ status: 'open' });
    const completed = await store.list({ status: 'completed' });

    expect(open).toHaveLength(2);
    expect(completed).toHaveLength(1);
  });

  it('update merges patch correctly', async () => {
    const store = createInvoiceStore();
    const invoice = makeInvoice();
    await store.create(invoice);

    const updated = await store.update(invoice.id, {
      status: 'canceled',
      canceledAt: '2026-01-01T00:00:00.000Z',
    });

    expect(updated.status).toBe('canceled');
    expect(updated.canceledAt).toBe('2026-01-01T00:00:00.000Z');
    // Original fields preserved
    expect(updated.expectedAmountRaw).toBe(invoice.expectedAmountRaw);
    expect(updated.recipientAccount).toBe(invoice.recipientAccount);
  });

  it('update throws for unknown id', async () => {
    const store = createInvoiceStore();
    await expect(store.update('non-existent', { status: 'canceled' })).rejects.toThrow();
  });

  it('getByRecipientAccount filters by account and status', async () => {
    const store = createInvoiceStore();
    const account2 = 'nano_2testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg';

    await store.create(makeInvoice({ recipientAccount: TEST_ACCOUNT, status: 'open' }));
    await store.create(makeInvoice({ recipientAccount: TEST_ACCOUNT, status: 'completed' }));
    await store.create(makeInvoice({ recipientAccount: account2, status: 'open' }));

    const openForAccount1 = await store.getByRecipientAccount(TEST_ACCOUNT, 'open');
    expect(openForAccount1).toHaveLength(1);
    expect(openForAccount1[0]!.recipientAccount).toBe(TEST_ACCOUNT);
    expect(openForAccount1[0]!.status).toBe('open');
  });

  it('getByRecipientAccount without status filter returns all for account', async () => {
    const store = createInvoiceStore();
    await store.create(makeInvoice({ status: 'open' }));
    await store.create(makeInvoice({ status: 'completed' }));

    const all = await store.getByRecipientAccount(TEST_ACCOUNT);
    expect(all).toHaveLength(2);
  });

  it('getByIdempotencyKey returns invoice id', async () => {
    const store = createInvoiceStore();
    const invoice = makeInvoice();
    await store.create(invoice, 'my-key');

    const id = await store.getByIdempotencyKey('my-key');
    expect(id).toBe(invoice.id);
  });

  it('getByIdempotencyKey returns undefined for unknown key', async () => {
    const store = createInvoiceStore();
    const id = await store.getByIdempotencyKey('unknown-key');
    expect(id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PaymentStore
// ---------------------------------------------------------------------------

describe('PaymentStore', () => {
  it('create and get', async () => {
    const store = createPaymentStore();
    const invoiceId = randomUUID();
    const payment = makePayment({ invoiceId });
    await store.create(payment);

    const fetched = await store.get(payment.id);
    expect(fetched).toEqual(payment);
  });

  it('get returns undefined for unknown id', async () => {
    const store = createPaymentStore();
    const result = await store.get('non-existent');
    expect(result).toBeUndefined();
  });

  it('getByBlockHash returns correct payment', async () => {
    const store = createPaymentStore();
    const invoiceId = randomUUID();
    const blockHash = `hash_${randomUUID()}`;
    const payment = makePayment({ invoiceId, sendBlockHash: blockHash });
    await store.create(payment);

    const fetched = await store.getByBlockHash(blockHash);
    expect(fetched).toEqual(payment);
  });

  it('getByBlockHash returns undefined for unknown hash', async () => {
    const store = createPaymentStore();
    const result = await store.getByBlockHash('unknown-hash');
    expect(result).toBeUndefined();
  });

  it('listByInvoice returns matching payments', async () => {
    const store = createPaymentStore();
    const invoiceId1 = randomUUID();
    const invoiceId2 = randomUUID();

    const p1 = makePayment({ invoiceId: invoiceId1 });
    const p2 = makePayment({ invoiceId: invoiceId1 });
    const p3 = makePayment({ invoiceId: invoiceId2 });

    await store.create(p1);
    await store.create(p2);
    await store.create(p3);

    const forInvoice1 = await store.listByInvoice(invoiceId1);
    const forInvoice2 = await store.listByInvoice(invoiceId2);

    expect(forInvoice1).toHaveLength(2);
    expect(forInvoice2).toHaveLength(1);
    expect(forInvoice1.map((p) => p.id)).toContain(p1.id);
    expect(forInvoice1.map((p) => p.id)).toContain(p2.id);
  });

  it('listByInvoice returns empty for unknown invoice', async () => {
    const store = createPaymentStore();
    const result = await store.listByInvoice('non-existent-invoice');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EventStore
// ---------------------------------------------------------------------------

describe('EventStore', () => {
  it('append and listByInvoice', async () => {
    const store = createEventStore();
    const invoiceId = randomUUID();

    const invoice = makeInvoice({ id: invoiceId });
    await store.append({
      id: randomUUID(),
      type: 'invoice.created',
      createdAt: new Date().toISOString(),
      data: { invoice },
    });

    const events = await store.listByInvoice(invoiceId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('invoice.created');
  });

  it('appends multiple events for the same invoice', async () => {
    const store = createEventStore();
    const invoiceId = randomUUID();
    const invoice = makeInvoice({ id: invoiceId });

    await store.append({
      id: randomUUID(),
      type: 'invoice.created',
      createdAt: new Date().toISOString(),
      data: { invoice },
    });

    await store.append({
      id: randomUUID(),
      type: 'invoice.canceled',
      createdAt: new Date().toISOString(),
      data: { invoice: { ...invoice, status: 'canceled', canceledAt: new Date().toISOString() } },
    });

    const events = await store.listByInvoice(invoiceId);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('invoice.created');
    expect(events[1]!.type).toBe('invoice.canceled');
  });

  it('listByInvoice returns empty for unknown invoice', async () => {
    const store = createEventStore();
    const result = await store.listByInvoice('unknown-invoice-id');
    expect(result).toEqual([]);
  });

  it('events for different invoices are stored separately', async () => {
    const store = createEventStore();
    const invoiceId1 = randomUUID();
    const invoiceId2 = randomUUID();
    const inv1 = makeInvoice({ id: invoiceId1 });
    const inv2 = makeInvoice({ id: invoiceId2 });

    await store.append({
      id: randomUUID(),
      type: 'invoice.created',
      createdAt: new Date().toISOString(),
      data: { invoice: inv1 },
    });

    await store.append({
      id: randomUUID(),
      type: 'invoice.created',
      createdAt: new Date().toISOString(),
      data: { invoice: inv2 },
    });

    const events1 = await store.listByInvoice(invoiceId1);
    const events2 = await store.listByInvoice(invoiceId2);

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
  });

  it('listByInvoice respects after cursor', async () => {
    const store = createEventStore();
    const invoiceId = randomUUID();
    const inv = makeInvoice({ id: invoiceId });

    const id1 = randomUUID();
    const id2 = randomUUID();
    const id3 = randomUUID();

    await store.append({ id: id1, type: 'invoice.created', createdAt: new Date().toISOString(), data: { invoice: inv } });
    await store.append({ id: id2, type: 'payment.confirmed', createdAt: new Date().toISOString(), data: { payment: makePayment({ invoiceId }), invoice: inv } });
    await store.append({ id: id3, type: 'invoice.completed', createdAt: new Date().toISOString(), data: { invoice: inv } });

    const all = await store.listByInvoice(invoiceId);
    expect(all).toHaveLength(3);

    const after1 = await store.listByInvoice(invoiceId, { after: id1 });
    expect(after1).toHaveLength(2);
    expect(after1[0]!.id).toBe(id2);
    expect(after1[1]!.id).toBe(id3);

    const after2 = await store.listByInvoice(invoiceId, { after: id2 });
    expect(after2).toHaveLength(1);
    expect(after2[0]!.id).toBe(id3);

    const after3 = await store.listByInvoice(invoiceId, { after: id3 });
    expect(after3).toHaveLength(0);
  });

  it('listByInvoice returns all when cursor not found', async () => {
    const store = createEventStore();
    const invoiceId = randomUUID();
    const inv = makeInvoice({ id: invoiceId });

    await store.append({ id: randomUUID(), type: 'invoice.created', createdAt: new Date().toISOString(), data: { invoice: inv } });

    const result = await store.listByInvoice(invoiceId, { after: 'non-existent-id' });
    expect(result).toHaveLength(1);
  });
});
