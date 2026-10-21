// @openrai/runtime — Subscription deduplication & event fan-out
export class SubscriptionManager {
    addressToControllers = new Map();
    controllers = new Map();
    register(controller) {
        this.controllers.set(controller.id, controller);
    }
    subscribe(accountAddress, controller) {
        this.controllers.set(controller.id, controller);
        let set = this.addressToControllers.get(accountAddress);
        if (!set) {
            set = new Set();
            this.addressToControllers.set(accountAddress, set);
        }
        set.add(controller);
    }
    unsubscribe(accountAddress, controller) {
        const set = this.addressToControllers.get(accountAddress);
        if (set) {
            set.delete(controller);
            if (set.size === 0) {
                this.addressToControllers.delete(accountAddress);
            }
        }
    }
    publish(event) {
        const set = this.addressToControllers.get(event.accountAddress);
        if (!set)
            return;
        const payload = JSON.stringify(event);
        const frame = `id: ${event.id}\ndata: ${payload}\n\n`;
        for (const controller of set) {
            if (controller.closed)
                continue;
            try {
                controller.enqueue(frame);
            }
            catch {
                // Connection may have closed between check and enqueue
            }
        }
    }
    removeConnection(controller) {
        this.controllers.delete(controller.id);
        for (const set of this.addressToControllers.values()) {
            set.delete(controller);
        }
        // Clean up empty address entries
        for (const [address, set] of this.addressToControllers) {
            if (set.size === 0) {
                this.addressToControllers.delete(address);
            }
        }
    }
    getConnection(id) {
        return this.controllers.get(id);
    }
    hasSubscribers(accountAddress) {
        const set = this.addressToControllers.get(accountAddress);
        return set !== undefined && set.size > 0;
    }
}
//# sourceMappingURL=subscription-manager.js.map