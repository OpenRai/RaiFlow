export { RaiFlowClient, type RaiFlowClientOptions } from './client.js';
export {
  InvoicesResource,
  type CreateInvoiceOptions,
  type ListInvoicesOptions,
  type ListEventsOptions,
} from './resources/Invoices.js';
export {
  WebhooksResource,
  type CreateWebhookOptions,
} from './resources/Webhooks.js';

// Re-export canonical types from model
export type {
  Invoice,
  InvoiceStatus,
  Payment,
  PaymentStatus,
  RaiFlowEvent,
  RaiFlowEventType,
  EventEnvelope,
  CompletionPolicy,
  WebhookEndpoint,
} from '@openrai/model';

// Re-export webhook verification helper
export { verifySignature, signPayload } from '@openrai/webhook';
