import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Invoice, Payment, RaiFlowEvent } from '@openrai/model';
import { createEventStore, createInvoiceStore, createPaymentStore } from '../stores.js';

const ONE_XNO = '1000000000000000000000000000000';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    accountKey: 'customer-1',
    invoiceKey: randomUUID(),
    status: 'open',
    payAddress: 'nano_1testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg',
    expectedAmountRaw: ONE_XNO,
    receivedAmountRaw: '0',
    memo: null,
    metadata: null,
    idempotencyKey: null,
    expiresAt: null,
    completedAt: null,
    canceledAt: null,
    createdAt: now,
    updatedAt: now,
    completionPolicy: { type: 'at_least' },
    derivationIndex: 0,
    ...overrides,
  };
}

function makePayment(invoiceId: string, overrides: Partial<Payment> = {}): Payment {
  return {
    id: randomUUID(),
    invoiceId,
    status: 'confirmed',
    blockHash: `hash_${randomUUID()}`,
    senderAddress: null,
    amountRaw: ONE_XNO,
    confirmedAt: new Date().toISOString(),
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeEvent(invoice: Invoice, overrides: Partial<RaiFlowEvent> = {}): RaiFlowEvent {
  return {
    id: randomUUID(),
    type: 'invoice.created',
    timestamp: new Date().toISOString(),
    data: { invoice },
    resourceId: invoice.id,
    resourceType: 'invoice',
    ...overrides,
  };
}

describe('InvoiceStore', () => {
  it('creates and retrieves canonical invoices', async () => {
    const store = createInvoiceStore();
    const invoice = makeInvoice();
    await store.create(invoice);
    expect(await store.get(invoice.id)).toEqual(invoice);
  });

  it('deduplicates idempotency keys and compound application identities', async () => {
    const store = createInvoiceStore();
    const invoice = makeInvoice({ invoiceKey: 'order-1' });
    await store.create(invoice, 'create-order-1');
    expect((await store.create(makeInvoice(), 'create-order-1')).id).toBe(invoice.id);
    expect((await store.getByAccountKeyAndInvoiceKey('customer-1', 'order-1'))?.id).toBe(invoice.id);
  });

  it('lists by status, account key, and pay address', async () => {
    const store = createInvoiceStore();
    const first = makeInvoice({ accountKey: 'customer-1', status: 'open' });
    const second = makeInvoice({ accountKey: 'customer-1', status: 'completed' });
    const other = makeInvoice({ accountKey: 'customer-2', payAddress: 'nano_2testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg' });
    for (const invoice of [first, second, other]) await store.create(invoice);
    expect(await store.list({ status: 'open' })).toEqual([first, other]);
    expect(await store.listByAccountKey('customer-1')).toEqual([first, second]);
    expect(await store.getByPayAddress(first.payAddress, 'open')).toEqual([first]);
  });

  it('updates invoices and transitions only from the expected state', async () => {
    const store = createInvoiceStore();
    const invoice = makeInvoice();
    await store.create(invoice);
    expect((await store.transition(invoice.id, 'open', { status: 'canceled' }))?.status).toBe('canceled');
    expect(await store.transition(invoice.id, 'open', { status: 'completed' })).toBeUndefined();
    expect((await store.update(invoice.id, { receivedAmountRaw: ONE_XNO })).receivedAmountRaw).toBe(ONE_XNO);
  });
});

describe('PaymentStore', () => {
  it('retrieves canonical payments by id, source block, and invoice', async () => {
    const store = createPaymentStore();
    const payment = makePayment('invoice-1');
    await store.create(payment);
    expect(await store.get(payment.id)).toEqual(payment);
    expect(await store.getByBlockHash(payment.blockHash)).toEqual(payment);
    expect(await store.listByInvoice('invoice-1')).toEqual([payment]);
  });
});

describe('EventStore', () => {
  it('assigns ordered sequence cursors and filters persisted event shapes', async () => {
    const store = createEventStore();
    const invoice = makeInvoice();
    const created = makeEvent(invoice);
    const completed = makeEvent(invoice, { type: 'invoice.completed' });
    const other = makeEvent(makeInvoice());
    await store.append(created);
    await store.append(completed);
    await store.append(other);
    expect((await store.list({ resourceType: 'invoice', resourceId: invoice.id })).map((event) => event.id))
      .toEqual([created.id, completed.id]);
    expect((await store.list({ after: '1' })).map((event) => event.id)).toEqual([completed.id, other.id]);
  });
});
