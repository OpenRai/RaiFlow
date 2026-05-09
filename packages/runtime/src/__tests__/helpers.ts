// @openrai/runtime — Shared test helpers

import type { WebhookDelivery } from '@openrai/webhook';
import type { RaiFlowConfig } from '@openrai/config';
import type { LegacyRaiFlowEvent, ConfirmedBlock } from '@openrai/model';
import { Runtime } from '../runtime.js';

export const ONE_XNO = '1000000000000000000000000000000';
export const HALF_XNO = '500000000000000000000000000000';
export const TWO_XNO = '2000000000000000000000000000000';
export const TEST_ACCOUNT = 'nano_1testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg';
export const TEST_ACCOUNT_1 = TEST_ACCOUNT;
export const TEST_ACCOUNT_2 = 'nano_2testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg';

export function createTestConfig(overrides?: Partial<RaiFlowConfig['daemon']>): RaiFlowConfig {
  return {
    daemon: {
      host: '0.0.0.0',
      port: 3100,
      enableDashboardAuth: true,
      ...overrides,
    },
    nano: { rpc: [], ws: [], work: [] },
    custody: null,
    invoices: { defaultExpirySeconds: 3600, autoSweep: false, sweepDestination: null },
    storage: { driver: 'sqlite', path: './raiflow.db' },
    webhooks: [],
    logging: { level: 'info', format: 'pretty' },
  };
}

export function createTestRuntime() {
  const deliveredEvents: { event: LegacyRaiFlowEvent; endpoints: unknown[] }[] = [];
  const fakeDelivery: WebhookDelivery = {
    deliver: async (event: unknown, endpoints: unknown[]) => {
      deliveredEvents.push({ event: event as LegacyRaiFlowEvent, endpoints });
    },
    shutdown: () => {},
  };
  const runtime = new Runtime({ webhookDelivery: fakeDelivery });
  return { runtime, deliveredEvents };
}

export function makeBlock(
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

export function req(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const init: RequestInit = { method };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
    init.headers = { 'Content-Type': 'application/json', ...(options.headers ?? {}) };
  } else if (options.headers) {
    init.headers = options.headers;
  }
  return new Request(`http://localhost${path}`, init);
}

export async function parseJson(res: Response): Promise<unknown> {
  return res.json() as Promise<unknown>;
}
