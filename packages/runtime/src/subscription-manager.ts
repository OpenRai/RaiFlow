// @openrai/runtime — Subscription deduplication & event fan-out

import type { AccountEvent } from '@openrai/model';

export interface SSEController {
  id: string;
  enqueue(event: string): void;
  close(): void;
  readonly closed: boolean;
}

export class SubscriptionManager {
  private readonly addressToControllers = new Map<string, Set<SSEController>>();
  private readonly controllers = new Map<string, SSEController>();

  register(controller: SSEController): void {
    this.controllers.set(controller.id, controller);
  }

  subscribe(accountAddress: string, controller: SSEController): void {
    this.controllers.set(controller.id, controller);

    let set = this.addressToControllers.get(accountAddress);
    if (!set) {
      set = new Set();
      this.addressToControllers.set(accountAddress, set);
    }
    set.add(controller);
  }

  unsubscribe(accountAddress: string, controller: SSEController): void {
    const set = this.addressToControllers.get(accountAddress);
    if (set) {
      set.delete(controller);
      if (set.size === 0) {
        this.addressToControllers.delete(accountAddress);
      }
    }
  }

  publish(event: AccountEvent): void {
    const set = this.addressToControllers.get(event.accountAddress);
    if (!set) return;

    const payload = JSON.stringify(event);
    const frame = `data: ${payload}\n\n`;

    for (const controller of set) {
      if (controller.closed) continue;
      try {
        controller.enqueue(frame);
      } catch {
        // Connection may have closed between check and enqueue
      }
    }
  }

  removeConnection(controller: SSEController): void {
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

  getConnection(id: string): SSEController | undefined {
    return this.controllers.get(id);
  }

  hasSubscribers(accountAddress: string): boolean {
    const set = this.addressToControllers.get(accountAddress);
    return set !== undefined && set.size > 0;
  }
}
