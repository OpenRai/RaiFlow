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
export { SystemResource, type RuntimeHealth } from './resources/System.js';

// Re-export canonical types from model
export type {
  Invoice,
  InvoiceStatus,
  Payment,
  PaymentStatus,
  Account,
  AccountType,
  Send,
  SendStatus,
  RaiFlowEvent,
  RaiFlowEventType,
  CompletionPolicy,
  WebhookEndpoint,
  CreateInvoiceRequest,
  CreateAccountRequest,
  SendRequest,
  PublishBlockRequest,
  WorkGenerateRequest,
  CreateWebhookRequest,
  EventQueryOptions,
  PaginatedEventsResponse,
  RaiFlowError,
} from '@openrai/model';

// Re-export webhook verification helper
export { verifySignature, signPayload } from '@openrai/webhook';
