export { RaiFlowClient, RaiFlowApiError, type RaiFlowClientOptions } from './client.js';
export {
  AccountsResource,
  type CreateManagedAccountOptions,
  type CreateWatchedAccountOptions,
  type ListAccountsOptions,
} from './resources/Accounts.js';
/** Escape hatch for non-custodial pre-signed block flows. Use SendsResource for custodial flows. */
export {
  BlocksResource,
  type PublishBlockResult,
} from './resources/Blocks.js';
export {
  InvoicesResource,
  type CreateInvoiceOptions,
  type ListInvoicesOptions,
} from './resources/Invoices.js';
export {
  SendsResource,
  type QueueSendOptions,
} from './resources/Sends.js';
export {
  WebhooksResource,
  type CreateWebhookOptions,
} from './resources/Webhooks.js';
export { SystemResource, type RuntimeHealth, type RuntimeVersion } from './resources/System.js';
export { EventsResource } from './resources/Events.js';
export { DepositsResource, type CreateRefundOptions } from './resources/Deposits.js';
/** Low-level work generation. If you need this directly, it indicates a missing SDK feature. */
export {
  WorkResource,
  type WorkGenerateResult,
} from './resources/Work.js';

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
  Deposit,
  Refund,
  RaiFlowEvent,
  RaiFlowEventType,
  CompletionPolicy,
  WebhookEndpoint,
  CreateInvoiceRequest,
  CreateAccountRequest,
  WatchAccountRequest,
  UpdateAccountRequest,
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
