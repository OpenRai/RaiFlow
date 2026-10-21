import type { RaiFlowConfig } from '@openrai/config';
import { type RaiFlowEvent, type ConfirmedBlock } from '@openrai/model';
import { vi } from 'vitest';
import { Runtime } from '../runtime.js';
export declare const ONE_XNO = "1000000000000000000000000000000";
export declare const HALF_XNO = "500000000000000000000000000000";
export declare const TWO_XNO = "2000000000000000000000000000000";
export declare const TEST_ACCOUNT = "nano_1testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg";
export declare const TEST_ACCOUNT_1 = "nano_1testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg";
export declare const TEST_ACCOUNT_2 = "nano_2testaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg";
export declare function createTestConfig(overrides?: Partial<RaiFlowConfig['daemon']>): RaiFlowConfig;
export declare function createTestRuntime(options?: {
    watcher?: {
        addAccount(account: string): void;
        removeAccount(account: string): void;
    };
}): {
    runtime: Runtime;
    deliveredEvents: {
        event: RaiFlowEvent;
        endpoints: unknown[];
    }[];
};
export declare function makeBlock(overrides: Partial<ConfirmedBlock> & {
    recipientAccount: string;
}): ConfirmedBlock;
export declare function req(method: string, path: string, options?: {
    body?: unknown;
    headers?: Record<string, string>;
}): Request;
export declare function createTestInvoice(runtime: Runtime): Promise<import("@openrai/model").Invoice>;
export declare function createAndPayInvoice(runtime: Runtime, amountRaw?: string, recipientAccount?: string): Promise<{
    invoice: import("@openrai/model").Invoice;
    block: ConfirmedBlock;
}>;
export declare function createHandlerWithRuntime(runtime: Runtime, config: ReturnType<typeof createTestConfig>): (req: Request) => Promise<Response>;
export declare function createHandlerWithInvoice(runtime: Runtime, config: ReturnType<typeof createTestConfig>): Promise<{
    handler: (req: Request) => Promise<Response>;
    invoice: import("@openrai/model").Invoice;
}>;
export declare function createMockRpcClient(overrides?: {
    processError?: Error | null;
    accountsReceivable?: ReturnType<typeof vi.fn>;
    workGenerate?: ReturnType<typeof vi.fn>;
    healthCheck?: ReturnType<typeof vi.fn>;
}): {
    healthCheck: import("vitest").Mock<(...args: any[]) => any>;
    process: import("vitest").Mock<(...args: any[]) => any>;
    accountsReceivable: import("vitest").Mock<(...args: any[]) => any>;
    workGenerate: import("vitest").Mock<(...args: any[]) => any>;
};
export declare function parseJson(res: Response): Promise<unknown>;
