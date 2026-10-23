import type { SendBlockIntent, SendBlockIntentStore } from '@openrai/storage';

export function createInMemorySendBlockIntentStore(): SendBlockIntentStore {
  const intents = new Map<string, SendBlockIntent>();
  return {
    async get(sendId) {
      return intents.get(sendId);
    },
    async createIfAbsent(intent) {
      const existing = intents.get(intent.sendId);
      if (existing) return existing;
      intents.set(intent.sendId, intent);
      return intent;
    },
    async updateWork(sendId, blockHash, blockJson) {
      const existing = intents.get(sendId);
      if (!existing || existing.blockHash !== blockHash) return false;
      intents.set(sendId, { ...existing, blockJson });
      return true;
    },
  };
}
