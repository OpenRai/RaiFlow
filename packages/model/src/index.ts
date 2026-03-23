// @openrai/model
// Canonical shared types and schemas for RaiFlow

export type InvoiceStatus =
  | 'pending'
  | 'payment_detected'
  | 'completed'
  | 'expired'
  | 'cancelled'

export type EventType =
  | 'invoice.created'
  | 'payment.detected'
  | 'payment.confirmed'
  | 'invoice.completed'
  | 'invoice.expired'
  | 'webhook.delivery_failed'

export interface Invoice {
  id: string
  address: string
  amountRaw: string
  status: InvoiceStatus
  metadata: Record<string, unknown>
  createdAt: string
  expiresAt?: string
  completedAt?: string
}

export interface PaymentProof {
  id: string
  invoiceId: string
  fromAddress: string
  toAddress: string
  amountRaw: string
  blockHash: string
  confirmedAt: string
  metadata: Record<string, unknown>
}

export interface Event {
  id: string
  type: EventType
  invoiceId: string
  payload: Record<string, unknown>
  createdAt: string
}

export interface WebhookEndpoint {
  id: string
  url: string
  secret: string
  eventTypes: EventType[]
  createdAt: string
}
