import { randomUUID } from 'node:crypto';
import { NanoAddress } from '@openrai/nano-core';
export class ReceiveOrchestrator {
    receiveTaskStore;
    custodyEngine;
    rpcPool;
    emitEvent;
    processing = false;
    constructor(receiveTaskStore, custodyEngine, rpcPool, emitEvent) {
        this.receiveTaskStore = receiveTaskStore;
        this.custodyEngine = custodyEngine;
        this.rpcPool = rpcPool;
        this.emitEvent = emitEvent;
    }
    enqueueReceivables(address, derivationIndex) {
        void this._enqueueReceivables(address, derivationIndex);
    }
    async _enqueueReceivables(address, derivationIndex) {
        try {
            const client = this.rpcPool.getClient();
            const receivable = await client.accountsReceivable(address);
            const entries = this.normalizeReceivables(receivable);
            for (const entry of entries) {
                try {
                    await this.receiveTaskStore.create({
                        accountAddress: address,
                        derivationIndex,
                        pendingBlockHash: entry.hash,
                        amountRaw: entry.amount,
                        status: 'pending',
                        publishedAt: null,
                        confirmedAt: null,
                        failedAt: null,
                        failReason: null,
                        retryCount: 0,
                    });
                }
                catch {
                    // UNIQUE violation / already exists → idempotent no-op
                }
            }
        }
        catch {
            // RPC failure — silently ignore and retry later
        }
    }
    async processNext() {
        if (this.processing)
            return;
        this.processing = true;
        try {
            const pending = await this.receiveTaskStore.listByStatus('pending');
            if (pending.length === 0)
                return;
            const task = pending[0];
            await this.receiveTaskStore.update(task.id, { status: 'processing' });
            try {
                const client = this.rpcPool.getClient();
                // RpcClient returns undefined only for a genuinely unopened account.
                // Transport failures must retry; treating them as unopened can build a
                // conflicting open block for an account that already has a frontier.
                const accountInfo = await client.accountInfo(task.accountAddress);
                const frontier = accountInfo?.frontier ?? '';
                const resultingBalanceRaw = (BigInt(accountInfo?.balance ?? '0') + BigInt(task.amountRaw)).toString();
                const signed = await this.custodyEngine.signReceive(task.accountAddress, task.pendingBlockHash, resultingBalanceRaw, frontier, task.derivationIndex);
                const work = await this.custodyEngine.generateReceiveWork(frontier === '' ? NanoAddress.parse(task.accountAddress).publicKey : frontier);
                const blockJson = JSON.parse(signed.contents);
                blockJson['work'] = work;
                let receiveBlockHash;
                try {
                    receiveBlockHash = (await client.process(JSON.stringify(blockJson))).hash;
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (!message.includes('Old block'))
                        throw error;
                }
                await this.receiveTaskStore.update(task.id, {
                    status: 'published',
                    receiveBlockHash: receiveBlockHash ?? null,
                    publishedAt: new Date().toISOString(),
                });
                await this.emitEvent({
                    id: randomUUID(),
                    type: 'receive.published',
                    timestamp: new Date().toISOString(),
                    data: { receive: { ...task, status: 'published', receiveBlockHash: receiveBlockHash ?? null } },
                    resourceId: task.id,
                    resourceType: 'account',
                });
            }
            catch (err) {
                const retryCount = (task.retryCount ?? 0) + 1;
                if (retryCount >= 3) {
                    await this.receiveTaskStore.update(task.id, {
                        status: 'failed',
                        failedAt: new Date().toISOString(),
                        failReason: err instanceof Error ? err.message : String(err),
                        retryCount,
                    });
                    try {
                        await this.emitEvent({
                            id: randomUUID(),
                            type: 'receive.failed',
                            timestamp: new Date().toISOString(),
                            data: { task: { ...task, retryCount, status: 'failed' } },
                            resourceId: task.id,
                            resourceType: 'receive_task',
                        });
                    }
                    catch {
                        // swallow event emission failures
                    }
                }
                else {
                    await this.receiveTaskStore.update(task.id, {
                        status: 'pending',
                        retryCount,
                    });
                }
            }
        }
        finally {
            this.processing = false;
        }
    }
    async handleConfirmedReceive(blockHash) {
        const task = await this.receiveTaskStore.getByPendingBlockHash(blockHash).catch(() => undefined);
        if (!task)
            return;
        if (task.status !== 'published')
            return;
        await this.receiveTaskStore.update(task.id, {
            status: 'confirmed',
            confirmedAt: new Date().toISOString(),
        });
    }
    /** Mark RaiFlow's own receive/open block confirmed, then emit a durable event. */
    async handleConfirmedReceiveBlock(blockHash) {
        const published = await this.receiveTaskStore.listByStatus('published');
        const task = published.find((candidate) => candidate.receiveBlockHash === blockHash);
        if (!task)
            return;
        const updated = await this.receiveTaskStore.update(task.id, {
            status: 'confirmed',
            confirmedAt: new Date().toISOString(),
        });
        await this.emitEvent({
            id: randomUUID(),
            type: 'receive.confirmed',
            timestamp: new Date().toISOString(),
            data: { receive: updated, pendingBlockHash: updated.pendingBlockHash, receiveBlockHash: blockHash },
            resourceId: task.id,
            resourceType: 'account',
        });
    }
    normalizeReceivables(receivable) {
        if (Array.isArray(receivable)) {
            return receivable
                .filter((row) => typeof row === 'object' &&
                row !== null &&
                typeof row.hash === 'string' &&
                typeof row.amount === 'string')
                .map((row) => ({ hash: row.hash, amount: row.amount }));
        }
        if (typeof receivable === 'object' && receivable !== null) {
            const blocks = receivable.blocks;
            if (blocks && typeof blocks === 'object') {
                return Object.entries(blocks).map(([hash, info]) => {
                    const amount = typeof info === 'object' &&
                        info !== null &&
                        'amount' in info &&
                        typeof info.amount === 'string'
                        ? info.amount
                        : String(info);
                    return { hash, amount };
                });
            }
        }
        return [];
    }
}
//# sourceMappingURL=receive-orchestrator.js.map