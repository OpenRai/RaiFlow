import type { AccountEvent } from '@openrai/model';
export interface SSEController {
    id: string;
    enqueue(event: string): void;
    close(): void;
    readonly closed: boolean;
}
export declare class SubscriptionManager {
    private readonly addressToControllers;
    private readonly controllers;
    register(controller: SSEController): void;
    subscribe(accountAddress: string, controller: SSEController): void;
    unsubscribe(accountAddress: string, controller: SSEController): void;
    publish(event: AccountEvent): void;
    removeConnection(controller: SSEController): void;
    getConnection(id: string): SSEController | undefined;
    hasSubscribers(accountAddress: string): boolean;
}
