import type { AccountStore, RaiFlowEvent, SendStore } from '@openrai/model';
import type { CustodyEngine } from '@openrai/custody';
import type { RpcPool } from '@openrai/rpc';
export declare class SendOrchestrator {
    private readonly sendStore;
    private readonly accountStore;
    private readonly custodyEngine;
    private readonly rpcPool;
    private readonly emitEvent;
    private timer;
    private processing;
    constructor(sendStore: SendStore, accountStore: AccountStore, custodyEngine: CustodyEngine, rpcPool: RpcPool, emitEvent: (event: RaiFlowEvent) => Promise<void>);
    start(intervalMs?: number): void;
    stop(): void;
    tick(): Promise<void>;
    private publishSend;
    /** Reconcile send confirmation even when no WebSocket watcher is configured. */
    private confirmPublishedSend;
}
