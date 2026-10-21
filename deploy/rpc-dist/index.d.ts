import type { EndpointAuditRecord } from '@openrai/nano-core/transport';
import type { ConfirmedBlock } from '@openrai/model';
export interface RpcNodeConfig {
    rpc: string[];
    ws: string[];
}
export interface RpcClient {
    healthCheck(): Promise<void>;
    accountInfo(account: string): Promise<AccountInfoResponse | undefined>;
    accountsReceivable(account: string): Promise<Receivable[]>;
    /** Read confirmation state for a published block. */
    blockInfo(hash: string): Promise<BlockInfoResponse | undefined>;
    process(block: string): Promise<ProcessResponse>;
    workGenerate(hash: string): Promise<WorkGenerateResponse>;
    getAuditReport(): EndpointAuditRecord[];
}
export type RpcEndpointHealthStatus = 'healthy' | 'unhealthy';
/** Bounded, operator-facing probe result for one configured Nano RPC URL. */
export interface RpcEndpointHealth {
    url: string;
    status: RpcEndpointHealthStatus;
    checkedAt: string;
    latencyMs: number | null;
    /** The least-expensive RPC action that established reachability. */
    probeAction?: 'version' | 'block_count';
    error?: string;
}
export interface RpcHealthReport {
    status: 'healthy' | 'degraded' | 'down' | 'unconfigured';
    checkedAt: string | null;
    endpoints: RpcEndpointHealth[];
    healthyCount: number;
    failedCount: number;
}
export interface AccountInfoResponse {
    frontier: string;
    balance: string;
    representative: string;
    blockCount: number;
}
export interface Receivable {
    hash: string;
    amount: string;
    sender: string;
}
export interface ProcessResponse {
    hash: string;
}
export interface BlockInfoResponse {
    confirmed: boolean;
    subtype?: string;
    blockAccount?: string;
    amount?: string;
    /** Decoded destination for a state send, when the node returns JSON block contents. */
    recipientAccount?: string;
    localTimestamp?: string;
}
export interface WorkGenerateResponse {
    work: string;
}
export interface RpcPool {
    getClient(): RpcClient;
    addNode(config: RpcNodeConfig): void;
    removeNode(rpcUrl: string): void;
    getActiveNode(): RpcClient | undefined;
    onStateChange(listener: (state: RpcPoolState) => void): () => void;
    getAuditReport(): EndpointAuditRecord[];
    /** Probe every configured URL with a short-lived cache to avoid amplification. */
    getHealthReport?(options?: {
        force?: boolean;
    }): Promise<RpcHealthReport>;
}
export interface RpcPoolState {
    status: 'connected' | 'disconnected' | 'failover';
    activeNode?: RpcNodeConfig;
    previousNode?: RpcNodeConfig;
}
export declare function createRpcPool(nodes: RpcNodeConfig[]): RpcPool;
export interface WsClient {
    connect(accounts: string[]): Promise<void>;
    disconnect(): void;
    addAccount(account: string): void;
    removeAccount(account: string): void;
    onConfirmation(listener: (block: ConfirmedBlock) => void): () => void;
    getAuditReport(): EndpointAuditRecord[];
}
export declare function createWsClient(wsUrl?: string): WsClient;
