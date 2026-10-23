import type { ReceiveBlockIntent, ReceiveBlockIntentStore } from '@openrai/storage';

export function createInMemoryReceiveBlockIntentStore(): ReceiveBlockIntentStore {
  const intents = new Map<string, ReceiveBlockIntent>();
  return {
    async get(taskId) {
      return intents.get(taskId);
    },
    async createIfAbsent(intent) {
      const existing = intents.get(intent.taskId);
      if (existing) return existing;
      intents.set(intent.taskId, intent);
      return intent;
    },
    async updateWork(taskId, blockHash, blockJson) {
      const existing = intents.get(taskId);
      if (!existing || existing.blockHash !== blockHash) return false;
      intents.set(taskId, { ...existing, blockJson });
      return true;
    },
  };
}
