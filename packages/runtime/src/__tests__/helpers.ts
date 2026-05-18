// @openrai/runtime — Shared test helpers

import type { WebhookDelivery } from '@openrai/webhook';
import type { RaiFlowConfig } from '@openrai/config';
import type { RaiFlowEvent, ConfirmedBlock, EventStore } from '@openrai/model';
import { createCustodyEngine } from '@openrai/custody';
import { vi } from 'vitest';
import { Runtime } from '../runtime.js';
import { createHandler } from '../handler.js';

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
  const deliveredEvents: { event: RaiFlowEvent; endpoints: unknown[] }[] = [];
  const fakeDelivery: WebhookDelivery = {
    deliver: async (event: unknown, endpoints: unknown[]) => {
      deliveredEvents.push({ event: event as RaiFlowEvent, endpoints });
    },
    shutdown: () => {},
  };
  const custodyEngine = createCustodyEngine({
    seed: '9f4f272617f01c4db7d5ebc0f4ef5baf6286f09ad7f295d08f6f41e88c2e6d14',
    representative: 'nano_3arg3asgtigae3zha8xw5rh4n83d3f4h6f9y4w6q37fph4n8tqbo6j8qzszk',
    derivationStartIndex: {
      invoice: 0,
      managed: 1_000_000,
    },
  });
  custodyEngine.loadSeed('9f4f272617f01c4db7d5ebc0f4ef5baf6286f09ad7f295d08f6f41e88c2e6d14');
  const v2Events: RaiFlowEvent[] = [];
  const v2EventStore: EventStore = {
    async append(event) {
      v2Events.push(event);
    },
    async list(options) {
      const limit = options?.limit ?? 100;
      return v2Events
        .filter((event) => (options?.after ? event.id > options.after : true))
        .filter((event) => (options?.type ? event.type === options.type : true))
        .filter((event) => (options?.resourceType ? event.resourceType === options.resourceType : true))
        .filter((event) => (options?.resourceId ? event.resourceId === options.resourceId : true))
        .slice(0, limit);
    },
  };
  const runtime = new Runtime({ webhookDelivery: fakeDelivery, custodyEngine, v2EventStore });
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

export async function createTestInvoice(runtime: Runtime) {
  return runtime.createInvoice({
    expectedAmountRaw: ONE_XNO,
  });
}

export async function createAndPayInvoice(
  runtime: Runtime,
  amountRaw: string = ONE_XNO,
  recipientAccount?: string,
) {
  const invoice = await createTestInvoice(runtime);
  const block = makeBlock({ recipientAccount: recipientAccount ?? invoice.payAddress, amountRaw });
  await runtime.handleConfirmedBlock(block);
  return { invoice, block };
}

export function createHandlerWithRuntime(runtime: Runtime, config: ReturnType<typeof createTestConfig>) {
  return createHandler(runtime, config);
}

export async function createHandlerWithInvoice(
  runtime: Runtime,
  config: ReturnType<typeof createTestConfig>,
) {
  const invoice = await createTestInvoice(runtime);
  const handler = createHandler(runtime, config);
  return { handler, invoice };
}

export function createMockRpcClient(overrides?: {
  processError?: Error | null;
  accountsReceivable?: ReturnType<typeof vi.fn>;
  workGenerate?: ReturnType<typeof vi.fn>;
}) {
  return {
    process: vi.fn().mockRejectedValue(overrides?.processError ?? null),
    accountsReceivable: overrides?.accountsReceivable ?? vi.fn().mockResolvedValue([]),
    workGenerate: overrides?.workGenerate ?? vi.fn().mockResolvedValue({ work: 'test-work' }),
  };
}

export async function parseJson(res: Response): Promise<unknown> {
  return res.json() as Promise<unknown>;
}
