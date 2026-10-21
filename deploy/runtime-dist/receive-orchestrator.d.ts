import type { ReceiveTaskStore } from '@openrai/model';
import type { CustodyEngine } from '@openrai/custody';
import type { RpcPool } from '@openrai/rpc';
export declare class ReceiveOrchestrator {
    private readonly receiveTaskStore;
    private readonly custodyEngine;
    private readonly rpcPool;
    private readonly emitEvent;
    private processing;
    constructor(receiveTaskStore: ReceiveTaskStore, custodyEngine: CustodyEngine, rpcPool: RpcPool, emitEvent: (event: unknown) => Promise<void>);
    enqueueReceivables(address: string, derivationIndex: number): void;
    private _enqueueReceivables;
    processNext(): Promise<void>;
    handleConfirmedReceive(blockHash: string): Promise<void>;
    /** Mark RaiFlow's own receive/open block confirmed, then emit a durable event. */
    handleConfirmedReceiveBlock(blockHash: string): Promise<void>;
    private normalizeReceivables;
}
