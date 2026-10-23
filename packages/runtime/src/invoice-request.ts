import { NanoAmount } from '@openrai/nano-core';
import { RaiFlowError, type CompletionPolicy } from '@openrai/model';

export interface ParsedCreateInvoiceRequest {
  accountKey: string;
  invoiceKey?: string;
  expectedAmountRaw: string;
  expiresAt?: string;
  metadata?: Record<string, string>;
  completionPolicy?: CompletionPolicy;
}

function badRequest(message: string): never {
  throw RaiFlowError.badRequest(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the shared wire contract and normalize its amount to exact raw units. */
export function parseCreateInvoiceRequest(value: unknown): ParsedCreateInvoiceRequest {
  if (!isRecord(value)) badRequest('Invoice request body must be an object');

  const allowedFields = new Set([
    'accountKey', 'invoiceKey', 'expectedAmountRaw', 'expectedAmount',
    'expiresAt', 'metadata', 'completionPolicy',
  ]);
  const unknownField = Object.keys(value).find((field) => !allowedFields.has(field));
  if (unknownField) badRequest(`Unknown invoice request field: ${unknownField}`);

  if (typeof value.accountKey !== 'string' || value.accountKey.length === 0) {
    badRequest('accountKey is required and must be a non-empty string');
  }
  if (value.invoiceKey !== undefined && typeof value.invoiceKey !== 'string') {
    badRequest('invoiceKey must be a string');
  }
  if (value.expiresAt !== undefined && typeof value.expiresAt !== 'string') {
    badRequest('expiresAt must be a string');
  }
  let expiresAt: string | undefined;
  if (typeof value.expiresAt === 'string') {
    const timestamp = Date.parse(value.expiresAt);
    if (!Number.isFinite(timestamp)) badRequest('expiresAt must be a valid date-time');
    expiresAt = new Date(timestamp).toISOString();
  }

  const hasRaw = Object.hasOwn(value, 'expectedAmountRaw');
  const hasNano = Object.hasOwn(value, 'expectedAmount');
  if (hasRaw === hasNano) {
    badRequest('Provide exactly one of expectedAmountRaw or expectedAmount');
  }

  let amount: NanoAmount;
  try {
    if (hasRaw) {
      if (typeof value.expectedAmountRaw !== 'string') {
        badRequest('expectedAmountRaw must be a decimal integer string');
      }
      amount = NanoAmount.fromRaw(value.expectedAmountRaw);
    } else {
      if (typeof value.expectedAmount !== 'string') {
        badRequest('expectedAmount must be a decimal XNO string');
      }
      amount = NanoAmount.fromNano(value.expectedAmount);
    }
  } catch (error) {
    if (error instanceof RaiFlowError) throw error;
    badRequest(error instanceof Error ? error.message : 'Invalid invoice amount');
  }
  if (amount.raw === '0') badRequest('Invoice amount must be greater than zero');

  let metadata: Record<string, string> | undefined;
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)
      || Object.values(value.metadata).some((entry) => typeof entry !== 'string')) {
      badRequest('metadata must be an object with string values');
    }
    metadata = value.metadata as Record<string, string>;
  }

  let completionPolicy: CompletionPolicy | undefined;
  if (value.completionPolicy !== undefined) {
    if (!isRecord(value.completionPolicy)
      || Object.keys(value.completionPolicy).length !== 1
      || (value.completionPolicy.type !== 'exact' && value.completionPolicy.type !== 'at_least')) {
      badRequest('completionPolicy.type must be "exact" or "at_least"');
    }
    completionPolicy = value.completionPolicy as CompletionPolicy;
  }

  const request = {
    accountKey: value.accountKey,
    expectedAmountRaw: amount.raw,
    ...(typeof value.invoiceKey === 'string' ? { invoiceKey: value.invoiceKey } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(metadata ? { metadata } : {}),
    ...(completionPolicy ? { completionPolicy } : {}),
  };
  // The public union also accepts XNO strings, while internal services consume
  // the normalized raw representation.
  return request satisfies ParsedCreateInvoiceRequest;
}
