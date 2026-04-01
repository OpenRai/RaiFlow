// @openrai/events — Event bus, persistence, and querying

import type { RaiFlowEvent, EventStore as ModelEventStore, EventQueryOptions } from '@openrai/model';

export type EventListener = (event: RaiFlowEvent) => void | Promise<void>;

export interface EventBus {
  subscribe(listener: EventListener): () => void;
  emit(event: RaiFlowEvent): Promise<void>;
}

export function createEventBus(): EventBus {
  const listeners = new Set<EventListener>();

  return {
    subscribe(listener: EventListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async emit(event: RaiFlowEvent): Promise<void> {
      const promises: Promise<void>[] = [];
      for (const listener of listeners) {
        const result = listener(event);
        if (result instanceof Promise) {
          promises.push(result);
        }
      }
      await Promise.allSettled(promises);
    },
  };
}

export function createPersistentEventStore(
  store: ModelEventStore,
  bus?: EventBus,
): ModelEventStore {
  return {
    async append(event: RaiFlowEvent): Promise<void> {
      await store.append(event);
      if (bus) {
        await bus.emit(event);
      }
    },

    async list(options?: EventQueryOptions): Promise<RaiFlowEvent[]> {
      return store.list(options);
    },
  };
}
