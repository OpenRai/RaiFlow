// @openrai/runtime — Core business logic tests

import { describe, it, expect, beforeEach } from 'vitest';
import type { RaiFlowEvent, ConfirmedBlock } from '@openrai/model';
import type { WebhookDelivery } from '@openrai/webhook';
import { Runtime, xnoToRaw } from '../runtime.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ONE_XNO = '1000000000000000000000000000000';
const HALF_XNO = '500000000000000000000000000000';
const TWO_XNO = '2000000000000000000000000000000';

const TEST_ACCOUNT_1 = 'nano_1testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg';
const TEST_ACCOUNT_2 = 'nano_2testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg';

function makeBlock(
  overrides: Partial<ConfirmedBlock> & { recipientAccount: string },
): ConfirmedBlock {
  const { recipientAccount, ...rest } = overrides;
  return {
    blockHash: `hash_${Math.random().toString(36).slice(2)}`,
    senderAccount: TEST_ACCOUNT_2,
    recipientAccount,
    amountRaw: ONE_XNO,
    confirmedAt: new Date().toISOString(),
    ...rest,
  };
}

function createTestRuntime() {
  const deliveredEvents: { event: RaiFlowEvent; endpoints: unknown[] }[] = [];
  const fakeDelivery: WebhookDelivery = {
    deliver: async (event, endpoints) => {
      deliveredEvents.push({ event, endpoints });
    },
    shutdown: () => {},
  };
  const runtime = new Runtime({ webhookDelivery: fakeDelivery });
  return { runtime, deliveredEvents };
}

// ---------------------------------------------------------------------------
// Invoice creation tests
// ---------------------------------------------------------------------------

describe('createInvoice', () => {
  it('creates an invoice with correct defaults', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    expect(invoice.status).toBe('open');
    expect(invoice.confirmedAmountRaw).toBe('0');
    expect(invoice.currency).toBe('XNO');
    expect(invoice.recipientAccount).toBe(TEST_ACCOUNT_1);
    expect(invoice.expectedAmountRaw).toBe(ONE_XNO);
  });

  it('generates a UUID for the invoice id', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    // UUID v4 pattern
    expect(invoice.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('stores metadata correctly', async () => {
    const { runtime } = createTestRuntime();
    const metadata = { orderId: 'order-123', userId: 42 };
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
      metadata,
    });

    expect(invoice.metadata).toEqual(metadata);
  });

  it('sets expiresAt when provided', async () => {
    const { runtime } = createTestRuntime();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
      expiresAt,
    });

    expect(invoice.expiresAt).toBe(expiresAt);
  });

  it('emits invoice.created event', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    expect(deliveredEvents).toHaveLength(1);
    expect(deliveredEvents[0]!.event.type).toBe('invoice.created');
    expect((deliveredEvents[0]!.event.data as { invoice: typeof invoice }).invoice.id).toBe(invoice.id);
  });
});

// ---------------------------------------------------------------------------
// Invoice idempotency tests
// ---------------------------------------------------------------------------

describe('createInvoice idempotency', () => {
  it('two creates with the same idempotency key return the same invoice', async () => {
    const { runtime } = createTestRuntime();
    const key = 'idem-key-1';
    const inv1 = await runtime.createInvoice(
      { recipientAccount: TEST_ACCOUNT_1, expectedAmountRaw: ONE_XNO },
      key,
    );
    const inv2 = await runtime.createInvoice(
      { recipientAccount: TEST_ACCOUNT_1, expectedAmountRaw: ONE_XNO },
      key,
    );

    expect(inv1.id).toBe(inv2.id);
  });

  it('two creates with the same idempotency key emit only one invoice.created event', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    const key = 'idem-key-2';
    await runtime.createInvoice(
      { recipientAccount: TEST_ACCOUNT_1, expectedAmountRaw: ONE_XNO },
      key,
    );
    await runtime.createInvoice(
      { recipientAccount: TEST_ACCOUNT_1, expectedAmountRaw: ONE_XNO },
      key,
    );

    const createdEvents = deliveredEvents.filter((d) => d.event.type === 'invoice.created');
    expect(createdEvents).toHaveLength(1);
  });

  it('two creates with different idempotency keys create different invoices', async () => {
    const { runtime } = createTestRuntime();
    const inv1 = await runtime.createInvoice(
      { recipientAccount: TEST_ACCOUNT_1, expectedAmountRaw: ONE_XNO },
      'key-a',
    );
    const inv2 = await runtime.createInvoice(
      { recipientAccount: TEST_ACCOUNT_1, expectedAmountRaw: ONE_XNO },
      'key-b',
    );

    expect(inv1.id).not.toBe(inv2.id);
  });
});

// ---------------------------------------------------------------------------
// Invoice cancellation tests
// ---------------------------------------------------------------------------

describe('cancelInvoice', () => {
  it('canceling an open invoice sets status to canceled and canceledAt', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    const canceled = await runtime.cancelInvoice(invoice.id);

    expect(canceled.status).toBe('canceled');
    expect(canceled.canceledAt).toBeDefined();
  });

  it('canceling emits invoice.canceled event', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await runtime.cancelInvoice(invoice.id);

    const canceledEvents = deliveredEvents.filter((d) => d.event.type === 'invoice.canceled');
    expect(canceledEvents).toHaveLength(1);
    expect((canceledEvents[0]!.event.data as { invoice: typeof invoice }).invoice.id).toBe(invoice.id);
  });

  it('canceling a completed invoice throws with code conflict', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    // Complete the invoice via payment
    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: ONE_XNO,
    }));

    const completedInvoice = await runtime.getInvoice(invoice.id);
    expect(completedInvoice!.status).toBe('completed');

    await expect(runtime.cancelInvoice(invoice.id)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('canceling a non-existent invoice throws with code not_found', async () => {
    const { runtime } = createTestRuntime();

    await expect(runtime.cancelInvoice('non-existent-id')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

// ---------------------------------------------------------------------------
// Payment matching tests
// ---------------------------------------------------------------------------

describe('handleConfirmedBlock — full payment', () => {
  it('creates Payment and completes invoice when amount matches', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    const block = makeBlock({ recipientAccount: TEST_ACCOUNT_1, amountRaw: ONE_XNO });
    await runtime.handleConfirmedBlock(block);

    const payments = await runtime.getPaymentsByInvoice(invoice.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.invoiceId).toBe(invoice.id);
    expect(payments[0]!.amountRaw).toBe(ONE_XNO);
    expect(payments[0]!.sendBlockHash).toBe(block.blockHash);
    expect(payments[0]!.status).toBe('confirmed');
    expect(payments[0]!.currency).toBe('XNO');
  });

  it('updates confirmedAmountRaw on the invoice after payment', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: ONE_XNO,
    }));

    const updated = await runtime.getInvoice(invoice.id);
    expect(updated!.confirmedAmountRaw).toBe(ONE_XNO);
  });

  it('emits payment.confirmed event with payment and updated invoice', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: ONE_XNO,
    }));

    const confirmedEvents = deliveredEvents.filter((d) => d.event.type === 'payment.confirmed');
    expect(confirmedEvents).toHaveLength(1);
    const data = confirmedEvents[0]!.event.data as { payment: unknown; invoice: typeof invoice };
    expect(data.payment).toBeDefined();
    expect(data.invoice.id).toBe(invoice.id);
  });

  it('emits invoice.completed event when confirmed >= expected', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: ONE_XNO,
    }));

    const completedEvents = deliveredEvents.filter((d) => d.event.type === 'invoice.completed');
    expect(completedEvents).toHaveLength(1);
  });

  it('completed invoice has status completed and completedAt set', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: ONE_XNO,
    }));

    const completed = await runtime.getInvoice(invoice.id);
    expect(completed!.status).toBe('completed');
    expect(completed!.completedAt).toBeDefined();
  });

  it('payment record has correct recipientAccount and senderAccount', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    const block = makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      senderAccount: TEST_ACCOUNT_2,
      amountRaw: ONE_XNO,
    });
    await runtime.handleConfirmedBlock(block);

    const payments = await runtime.getPaymentsByInvoice(invoice.id);
    expect(payments[0]!.recipientAccount).toBe(TEST_ACCOUNT_1);
    expect(payments[0]!.senderAccount).toBe(TEST_ACCOUNT_2);
  });
});

// ---------------------------------------------------------------------------
// Partial payment tests
// ---------------------------------------------------------------------------

describe('handleConfirmedBlock — partial payments', () => {
  it('first payment updates confirmedAmountRaw but leaves status open', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: HALF_XNO,
    }));

    const updated = await runtime.getInvoice(invoice.id);
    expect(updated!.status).toBe('open');
    expect(updated!.confirmedAmountRaw).toBe(HALF_XNO);
  });

  it('second payment that meets threshold triggers completion', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: HALF_XNO,
    }));

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: HALF_XNO,
    }));

    const completed = await runtime.getInvoice(invoice.id);
    expect(completed!.status).toBe('completed');
    expect(completed!.confirmedAmountRaw).toBe(ONE_XNO);
  });

  it('event sequence: payment.confirmed, payment.confirmed, invoice.completed', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: HALF_XNO,
    }));

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: HALF_XNO,
    }));

    // Filter out invoice.created
    const paymentEvents = deliveredEvents.filter((d) =>
      d.event.type === 'payment.confirmed' || d.event.type === 'invoice.completed',
    );

    expect(paymentEvents[0]!.event.type).toBe('payment.confirmed');
    expect(paymentEvents[1]!.event.type).toBe('payment.confirmed');
    expect(paymentEvents[2]!.event.type).toBe('invoice.completed');
  });
});

// ---------------------------------------------------------------------------
// Idempotent block handling
// ---------------------------------------------------------------------------

describe('handleConfirmedBlock — idempotency', () => {
  it('calling handleConfirmedBlock twice with the same blockHash is a no-op the second time', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    const block = makeBlock({ recipientAccount: TEST_ACCOUNT_1, amountRaw: ONE_XNO });
    await runtime.handleConfirmedBlock(block);
    await runtime.handleConfirmedBlock(block);

    const payments = await runtime.getPaymentsByInvoice(invoice.id);
    expect(payments).toHaveLength(1);
  });

  it('only one set of events emitted for duplicate block', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    const block = makeBlock({ recipientAccount: TEST_ACCOUNT_1, amountRaw: ONE_XNO });
    await runtime.handleConfirmedBlock(block);
    await runtime.handleConfirmedBlock(block);

    const confirmedEvents = deliveredEvents.filter((d) => d.event.type === 'payment.confirmed');
    expect(confirmedEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// No match tests
// ---------------------------------------------------------------------------

describe('handleConfirmedBlock — no match', () => {
  it('block for an account with no open invoices is ignored', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    // No invoices created for this account

    await runtime.handleConfirmedBlock(makeBlock({ recipientAccount: TEST_ACCOUNT_1 }));

    // Only possible events are from invoice creation — there are none
    expect(deliveredEvents).toHaveLength(0);
  });

  it('block for an account with only completed invoices is ignored', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    // Complete the invoice
    const block1 = makeBlock({ recipientAccount: TEST_ACCOUNT_1, amountRaw: ONE_XNO });
    await runtime.handleConfirmedBlock(block1);

    const eventCountAfterCompletion = deliveredEvents.length;

    // Send another block — should be ignored since no open invoices remain
    const block2 = makeBlock({ recipientAccount: TEST_ACCOUNT_1, amountRaw: ONE_XNO });
    await runtime.handleConfirmedBlock(block2);

    expect(deliveredEvents).toHaveLength(eventCountAfterCompletion);
  });
});

// ---------------------------------------------------------------------------
// FIFO matching tests
// ---------------------------------------------------------------------------

describe('handleConfirmedBlock — FIFO matching', () => {
  it('when two invoices exist for the same account, the oldest one is matched first', async () => {
    const { runtime } = createTestRuntime();

    // Create invoices slightly apart in time by using explicit createdAt-like sorting
    // The stores sort by createdAt — we create them sequentially so the first is older
    const inv1 = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    // Small delay to ensure different createdAt timestamps
    await new Promise((resolve) => setTimeout(resolve, 5));

    const inv2 = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: TWO_XNO,
    });

    // Send a payment for ONE_XNO — should match the older invoice (inv1)
    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: ONE_XNO,
    }));

    const payments1 = await runtime.getPaymentsByInvoice(inv1.id);
    const payments2 = await runtime.getPaymentsByInvoice(inv2.id);

    expect(payments1).toHaveLength(1);
    expect(payments2).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Invoice list / query tests
// ---------------------------------------------------------------------------

describe('listInvoices and query methods', () => {
  it('lists all invoices', async () => {
    const { runtime } = createTestRuntime();
    await runtime.createInvoice({ recipientAccount: TEST_ACCOUNT_1, expectedAmountRaw: ONE_XNO });
    await runtime.createInvoice({ recipientAccount: TEST_ACCOUNT_2, expectedAmountRaw: ONE_XNO });

    const all = await runtime.listInvoices();
    expect(all).toHaveLength(2);
  });

  it('filters by status', async () => {
    const { runtime } = createTestRuntime();
    const inv1 = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });
    await runtime.createInvoice({ recipientAccount: TEST_ACCOUNT_2, expectedAmountRaw: ONE_XNO });
    await runtime.cancelInvoice(inv1.id);

    const open = await runtime.listInvoices({ status: 'open' });
    const canceled = await runtime.listInvoices({ status: 'canceled' });

    expect(open).toHaveLength(1);
    expect(canceled).toHaveLength(1);
    expect(canceled[0]!.id).toBe(inv1.id);
  });

  it('getPaymentsByInvoice returns payments for the invoice', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: ONE_XNO,
    }));

    const payments = await runtime.getPaymentsByInvoice(invoice.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.invoiceId).toBe(invoice.id);
  });

  it('getEventsByInvoice returns all events for the invoice', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: ONE_XNO,
    }));

    const events = await runtime.getEventsByInvoice(invoice.id);
    // invoice.created + payment.confirmed + invoice.completed
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type)).toEqual([
      'invoice.created',
      'payment.confirmed',
      'invoice.completed',
    ]);
  });
});

// ---------------------------------------------------------------------------
// xnoToRaw conversion tests
// ---------------------------------------------------------------------------

describe('xnoToRaw', () => {
  it('converts 1 XNO to raw', () => {
    expect(xnoToRaw('1')).toBe('1000000000000000000000000000000');
  });

  it('converts fractional XNO', () => {
    expect(xnoToRaw('0.001')).toBe('1000000000000000000000000000');
  });

  it('converts a tiny amount', () => {
    expect(xnoToRaw('0.00042')).toBe('420000000000000000000000000');
  });

  it('converts a large amount', () => {
    expect(xnoToRaw('133248')).toBe('133248000000000000000000000000000000');
  });

  it('converts amount with full 30-digit precision', () => {
    // 1 raw
    expect(xnoToRaw('0.000000000000000000000000000001')).toBe('1');
  });

  it('rejects empty string', () => {
    expect(() => xnoToRaw('')).toThrow('Invalid XNO amount');
  });

  it('rejects negative amounts', () => {
    expect(() => xnoToRaw('-1')).toThrow('Invalid XNO amount');
  });

  it('rejects zero', () => {
    expect(() => xnoToRaw('0')).toThrow('must be greater than zero');
  });

  it('rejects more than 30 decimal places', () => {
    expect(() => xnoToRaw('0.0000000000000000000000000000001')).toThrow('more than 30 decimal places');
  });

  it('trims whitespace', () => {
    expect(xnoToRaw('  1  ')).toBe('1000000000000000000000000000000');
  });
});

// ---------------------------------------------------------------------------
// expectedAmount convenience parameter tests
// ---------------------------------------------------------------------------

describe('createInvoice with expectedAmount (XNO)', () => {
  it('creates an invoice using XNO amount', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmount: '0.001',
    });

    expect(invoice.expectedAmountRaw).toBe('1000000000000000000000000000');
    expect(invoice.status).toBe('open');
  });

  it('expectedAmountRaw takes precedence if both provided', async () => {
    const { runtime } = createTestRuntime();
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
      expectedAmount: '999',
    });

    expect(invoice.expectedAmountRaw).toBe(ONE_XNO);
  });

  it('throws if neither expectedAmountRaw nor expectedAmount provided', async () => {
    const { runtime } = createTestRuntime();
    await expect(
      runtime.createInvoice({ recipientAccount: TEST_ACCOUNT_1 }),
    ).rejects.toThrow('Either expectedAmountRaw or expectedAmount is required');
  });
});

// ---------------------------------------------------------------------------
// Event listener (on/off) tests
// ---------------------------------------------------------------------------

describe('runtime.on / runtime.off', () => {
  it('listener receives events of the subscribed type', async () => {
    const { runtime } = createTestRuntime();
    const received: RaiFlowEvent[] = [];
    runtime.on('invoice.created', (ev) => { received.push(ev); });

    await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    // Listener is fire-and-forget — give microtasks a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe('invoice.created');
  });

  it('wildcard listener receives all event types', async () => {
    const { runtime } = createTestRuntime();
    const received: RaiFlowEvent[] = [];
    runtime.on('*', (ev) => { received.push(ev); });

    await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: ONE_XNO,
    }));

    await new Promise((r) => setTimeout(r, 10));
    // invoice.created + payment.confirmed + invoice.completed
    expect(received).toHaveLength(3);
    expect(received.map((e) => e.type)).toEqual([
      'invoice.created',
      'payment.confirmed',
      'invoice.completed',
    ]);
  });

  it('off removes a listener', async () => {
    const { runtime } = createTestRuntime();
    const received: RaiFlowEvent[] = [];
    const listener = (ev: RaiFlowEvent) => { received.push(ev); };
    runtime.on('invoice.created', listener);
    runtime.off('invoice.created', listener);

    await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(0);
  });

  it('listener that throws does not crash the runtime', async () => {
    const { runtime } = createTestRuntime();
    runtime.on('invoice.created', () => { throw new Error('boom'); });

    // Should not reject
    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    expect(invoice.status).toBe('open');
  });

  it('async listener that rejects does not crash the runtime', async () => {
    const { runtime } = createTestRuntime();
    runtime.on('invoice.created', async () => { throw new Error('async boom'); });

    const invoice = await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    expect(invoice.status).toBe('open');
  });

  it('multiple listeners on the same event type all fire', async () => {
    const { runtime } = createTestRuntime();
    const a: string[] = [];
    const b: string[] = [];
    runtime.on('invoice.created', () => { a.push('a'); });
    runtime.on('invoice.created', () => { b.push('b'); });

    await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(a).toEqual(['a']);
    expect(b).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// Completion policy tests
// ---------------------------------------------------------------------------

describe('completion policy', () => {
  it('at_least (default) completes when confirmed >= expected', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: ONE_XNO,
    }));

    await new Promise((r) => setTimeout(r, 10));
    const completed = deliveredEvents.find((e) => e.event.type === 'invoice.completed');
    expect(completed).toBeDefined();
  });

  it('at_least (default) completes when confirmed > expected (overpay)', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: TWO_XNO,
    }));

    await new Promise((r) => setTimeout(r, 10));
    const completed = deliveredEvents.find((e) => e.event.type === 'invoice.completed');
    expect(completed).toBeDefined();
  });

  it('exact policy completes only when confirmed === expected', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
      completionPolicy: { type: 'exact' },
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: HALF_XNO,
    }));

    await new Promise((r) => setTimeout(r, 10));
    const completed = deliveredEvents.find((e) => e.event.type === 'invoice.completed');
    expect(completed).toBeUndefined();

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: HALF_XNO,
    }));

    await new Promise((r) => setTimeout(r, 10));
    const completedNow = deliveredEvents.find((e) => e.event.type === 'invoice.completed');
    expect(completedNow).toBeDefined();
  });

  it('exact policy does NOT complete on overpay', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
      completionPolicy: { type: 'exact' },
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: TWO_XNO,
    }));

    await new Promise((r) => setTimeout(r, 10));
    const completed = deliveredEvents.find((e) => e.event.type === 'invoice.completed');
    expect(completed).toBeUndefined();

    const invoice = await runtime.getInvoice(
      (await runtime.listInvoices())[0]!.id,
    );
    expect(invoice!.status).toBe('open');
    expect(invoice!.confirmedAmountRaw).toBe(TWO_XNO);
  });

  it('exact policy completes when exact match received across multiple payments', async () => {
    const { runtime, deliveredEvents } = createTestRuntime();
    await runtime.createInvoice({
      recipientAccount: TEST_ACCOUNT_1,
      expectedAmountRaw: ONE_XNO,
      completionPolicy: { type: 'exact' },
    });

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: HALF_XNO,
    }));

    await new Promise((r) => setTimeout(r, 10));
    expect(deliveredEvents.find((e) => e.event.type === 'invoice.completed')).toBeUndefined();

    await runtime.handleConfirmedBlock(makeBlock({
      recipientAccount: TEST_ACCOUNT_1,
      amountRaw: HALF_XNO,
    }));

    await new Promise((r) => setTimeout(r, 10));
    expect(deliveredEvents.find((e) => e.event.type === 'invoice.completed')).toBeDefined();
  });
});
