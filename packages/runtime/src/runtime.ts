// @openrai/runtime — Runtime core

import { randomUUID } from 'node:crypto';
import type {
  Invoice,
  InvoiceStatus,
  InvoiceStore,
  PaymentStore,
  EventStore,
  RaiFlowEvent,
  RaiFlowEventType,
  WatcherSink,
  ConfirmedBlock,
} from '@openrai/model';
import {
  createWebhookDelivery,
  createWebhookEndpointStore,
  type WebhookDelivery,
  type WebhookEndpointStore,
} from '@openrai/webhook';
import {
  createInvoiceStore,
  createPaymentStore,
  createEventStore,
} from './stores.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventListener = (event: RaiFlowEvent) => void | Promise<void>;

// ---------------------------------------------------------------------------
// XNO → raw conversion
// ---------------------------------------------------------------------------

const RAW_PER_XNO_EXPONENT = 30;

/**
 * Convert a human-readable XNO amount string to raw (the smallest Nano unit).
 * Uses string manipulation + BigInt to avoid floating-point precision loss.
 *
 * @example xnoToRaw("1")      // "1000000000000000000000000000000"
 * @example xnoToRaw("0.001")  // "1000000000000000000000000000"
 */
export function xnoToRaw(xno: string): string {
  const trimmed = xno.trim();
  if (trimmed === '' || trimmed.startsWith('-')) {
    throw new Error(`Invalid XNO amount: ${xno}`);
  }

  const dotIndex = trimmed.indexOf('.');
  let integerPart: string;
  let fractionalPart: string;

  if (dotIndex === -1) {
    integerPart = trimmed;
    fractionalPart = '';
  } else {
    integerPart = trimmed.slice(0, dotIndex);
    fractionalPart = trimmed.slice(dotIndex + 1);
  }

  if (fractionalPart.length > RAW_PER_XNO_EXPONENT) {
    throw new Error(
      `XNO amount has more than ${RAW_PER_XNO_EXPONENT} decimal places: ${xno}`,
    );
  }

  // Pad fractional part to exactly 30 digits
  const padded = fractionalPart.padEnd(RAW_PER_XNO_EXPONENT, '0');
  const raw = BigInt(integerPart + padded);

  if (raw === 0n) {
    throw new Error(`XNO amount must be greater than zero: ${xno}`);
  }

  return raw.toString();
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  invoiceStore?: InvoiceStore;
  paymentStore?: PaymentStore;
  eventStore?: EventStore;
  webhookEndpointStore?: WebhookEndpointStore;
  webhookDelivery?: WebhookDelivery;
  /** Interval in ms for the expiry checker. Default 10000 (10s). */
  expiryIntervalMs?: number;
}

/** States that cannot be transitioned out of. */
const TERMINAL_STATES = new Set<InvoiceStatus>(['completed', 'expired', 'canceled']);

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class Runtime implements WatcherSink {
  readonly invoiceStore: InvoiceStore;
  readonly paymentStore: PaymentStore;
  readonly eventStore: EventStore;
  readonly webhookEndpointStore: WebhookEndpointStore;

  private readonly webhookDelivery: WebhookDelivery;
  private readonly expiryIntervalMs: number;
  private expiryTimer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(config: RuntimeConfig = {}) {
    this.invoiceStore = config.invoiceStore ?? createInvoiceStore();
    this.paymentStore = config.paymentStore ?? createPaymentStore();
    this.eventStore = config.eventStore ?? createEventStore();
    this.webhookEndpointStore =
      config.webhookEndpointStore ?? createWebhookEndpointStore();
    this.webhookDelivery = config.webhookDelivery ?? createWebhookDelivery();
    this.expiryIntervalMs = config.expiryIntervalMs ?? 10_000;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start the expiry scheduler. */
  start(): void {
    if (this.expiryTimer !== undefined) return;
    this.expiryTimer = setInterval(() => {
      void this.runExpiryCheck();
    }, this.expiryIntervalMs);
    // Allow Node.js to exit even if the timer is still running
    if (typeof this.expiryTimer === 'object' && this.expiryTimer !== null && 'unref' in this.expiryTimer) {
      (this.expiryTimer as NodeJS.Timeout).unref();
    }
  }

  /** Stop the expiry scheduler and shut down webhook delivery. */
  stop(): void {
    if (this.expiryTimer !== undefined) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    this.webhookDelivery.shutdown();
  }

  // -------------------------------------------------------------------------
  // Invoice management
  // -------------------------------------------------------------------------

  async createInvoice(
    params: {
      recipientAccount: string;
      /** Amount in raw (string). Provide this or `expectedAmount`. */
      expectedAmountRaw?: string;
      /** Amount in XNO (human-readable). Converted to raw via `xnoToRaw`. */
      expectedAmount?: string;
      expiresAt?: string;
      metadata?: Record<string, unknown>;
    },
    idempotencyKey?: string,
  ): Promise<Invoice> {
    const resolvedAmountRaw =
      params.expectedAmountRaw ??
      (params.expectedAmount !== undefined ? xnoToRaw(params.expectedAmount) : undefined);

    if (resolvedAmountRaw === undefined) {
      throw new Error('Either expectedAmountRaw or expectedAmount is required');
    }

    const invoice: Invoice = {
      id: randomUUID(),
      status: 'open',
      currency: 'XNO',
      expectedAmountRaw: resolvedAmountRaw,
      confirmedAmountRaw: '0',
      recipientAccount: params.recipientAccount,
      createdAt: new Date().toISOString(),
      expiresAt: params.expiresAt,
      metadata: params.metadata,
    };

    const stored = await this.invoiceStore.create(invoice, idempotencyKey);

    // If returned invoice has a different id, the idempotency key was a hit —
    // skip event emission for the deduplicated request.
    if (stored.id !== invoice.id) {
      return stored;
    }

    await this.emitEvent({
      id: randomUUID(),
      type: 'invoice.created',
      createdAt: new Date().toISOString(),
      data: { invoice: stored },
    });

    return stored;
  }

  async getInvoice(id: string): Promise<Invoice | undefined> {
    return this.invoiceStore.get(id);
  }

  async listInvoices(filter?: { status?: InvoiceStatus }): Promise<Invoice[]> {
    return this.invoiceStore.list(filter);
  }

  async cancelInvoice(id: string): Promise<Invoice> {
    const invoice = await this.invoiceStore.get(id);
    if (invoice === undefined) {
      throw Object.assign(new Error(`Invoice not found: ${id}`), { code: 'not_found' });
    }
    if (TERMINAL_STATES.has(invoice.status)) {
      throw Object.assign(
        new Error(`Invoice ${id} is already in terminal state: ${invoice.status}`),
        { code: 'conflict' },
      );
    }

    const updated = await this.invoiceStore.update(id, {
      status: 'canceled',
      canceledAt: new Date().toISOString(),
    });

    await this.emitEvent({
      id: randomUUID(),
      type: 'invoice.canceled',
      createdAt: new Date().toISOString(),
      data: { invoice: updated },
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // Payment / event queries
  // -------------------------------------------------------------------------

  async getPaymentsByInvoice(invoiceId: string) {
    return this.paymentStore.listByInvoice(invoiceId);
  }

  async getEventsByInvoice(invoiceId: string) {
    return this.eventStore.listByInvoice(invoiceId);
  }

  // -------------------------------------------------------------------------
  // Event listeners
  // -------------------------------------------------------------------------

  on(type: RaiFlowEventType | '*', listener: EventListener): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  off(type: RaiFlowEventType | '*', listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  // -------------------------------------------------------------------------
  // WatcherSink — the core matching logic
  // -------------------------------------------------------------------------

  async handleConfirmedBlock(block: ConfirmedBlock): Promise<void> {
    // Idempotency guard: if we already processed this block, skip.
    const existingPayment = await this.paymentStore.getByBlockHash(block.blockHash);
    if (existingPayment !== undefined) {
      return;
    }

    // Find open invoices for the recipient account, sorted oldest-first (FIFO).
    const openInvoices = await this.invoiceStore.getByRecipientAccount(
      block.recipientAccount,
      'open',
    );

    if (openInvoices.length === 0) return;

    // Sort by createdAt ascending — oldest first.
    openInvoices.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const invoice = openInvoices[0]!;

    // Create the payment record.
    const payment = await this.paymentStore.create({
      id: randomUUID(),
      invoiceId: invoice.id,
      status: 'confirmed',
      currency: 'XNO',
      amountRaw: block.amountRaw,
      recipientAccount: block.recipientAccount,
      senderAccount: block.senderAccount,
      sendBlockHash: block.blockHash,
      confirmedAt: block.confirmedAt,
    });

    // Update confirmed amount on the invoice.
    const newConfirmedRaw = (
      BigInt(invoice.confirmedAmountRaw) + BigInt(block.amountRaw)
    ).toString();

    const updatedInvoice = await this.invoiceStore.update(invoice.id, {
      confirmedAmountRaw: newConfirmedRaw,
    });

    // Emit payment.confirmed
    await this.emitEvent({
      id: randomUUID(),
      type: 'payment.confirmed',
      createdAt: new Date().toISOString(),
      data: { payment, invoice: updatedInvoice },
    });

    // Check if invoice is now fully paid.
    if (BigInt(newConfirmedRaw) >= BigInt(invoice.expectedAmountRaw)) {
      const completedInvoice = await this.invoiceStore.update(invoice.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });

      await this.emitEvent({
        id: randomUUID(),
        type: 'invoice.completed',
        createdAt: new Date().toISOString(),
        data: { invoice: completedInvoice },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------

  private async runExpiryCheck(): Promise<void> {
    const now = new Date().toISOString();
    const openInvoices = await this.invoiceStore.list({ status: 'open' });

    for (const invoice of openInvoices) {
      if (invoice.expiresAt !== undefined && invoice.expiresAt <= now) {
        const updated = await this.invoiceStore.update(invoice.id, {
          status: 'expired',
          expiredAt: new Date().toISOString(),
        });

        await this.emitEvent({
          id: randomUUID(),
          type: 'invoice.expired',
          createdAt: new Date().toISOString(),
          data: { invoice: updated },
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  private async emitEvent(event: RaiFlowEvent): Promise<void> {
    await this.eventStore.append(event);

    // Notify local listeners (fire-and-forget).
    const targets = [
      ...(this.listeners.get(event.type) ?? []),
      ...(this.listeners.get('*') ?? []),
    ];
    for (const fn of targets) {
      try { void Promise.resolve(fn(event)).catch(() => {}); } catch { /* swallow sync throws */ }
    }

    const endpoints = await this.webhookEndpointStore.getByEventType(event.type);
    await this.webhookDelivery.deliver(event, endpoints);
  }
}
