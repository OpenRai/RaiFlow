import { describe, it, expect, beforeEach } from 'vitest';
import type { RaiFlowEventType } from '@openrai/model';
import { createWebhookEndpointStore } from '../store.js';
import type { WebhookEndpointStore } from '../store.js';

/** Helper: creates an endpoint without a secret (auto-generation). */
const noSecret = (url: string, eventTypes: RaiFlowEventType[]) =>
  ({ url, eventTypes }) as Parameters<WebhookEndpointStore['create']>[0];

describe('createWebhookEndpointStore', () => {
  let store: WebhookEndpointStore;

  beforeEach(() => {
    store = createWebhookEndpointStore();
  });

  describe('create', () => {
    it('generates id, createdAt, and secret automatically', async () => {
      const ep = await store.create(noSecret('https://example.com/hook', ['invoice.created']));

      expect(ep.id).toBeTruthy();
      expect(typeof ep.id).toBe('string');
      expect(ep.createdAt).toBeTruthy();
      expect(typeof ep.createdAt).toBe('string');
      // Should be a valid ISO 8601 date
      expect(new Date(ep.createdAt).toISOString()).toBe(ep.createdAt);
      expect(ep.secret).toBeTruthy();
      expect(typeof ep.secret).toBe('string');
    });

    it('auto-generated secret is a hex string of 64 chars (32 bytes)', async () => {
      const ep = await store.create(noSecret('https://example.com/hook', ['invoice.created']));
      expect(ep.secret).toMatch(/^[0-9a-f]{64}$/);
    });

    it('preserves a provided secret', async () => {
      const mySecret = 'my-custom-secret';
      const ep = await store.create({
        url: 'https://example.com/hook',
        eventTypes: ['invoice.created'],
        secret: mySecret,
      });
      expect(ep.secret).toBe(mySecret);
    });

    it('preserves url and eventTypes', async () => {
      const ep = await store.create({
        url: 'https://hooks.example.com/raiflow',
        eventTypes: ['payment.confirmed', 'invoice.completed'],
        secret: 'test-secret',
      });
      expect(ep.url).toBe('https://hooks.example.com/raiflow');
      expect(ep.eventTypes).toEqual(['payment.confirmed', 'invoice.completed']);
    });

    it('generates unique ids for each call', async () => {
      const ep1 = await store.create(noSecret('https://a.com', ['invoice.created']));
      const ep2 = await store.create(noSecret('https://b.com', ['invoice.created']));
      expect(ep1.id).not.toBe(ep2.id);
    });
  });

  describe('get', () => {
    it('returns the created endpoint by id', async () => {
      const ep = await store.create(noSecret('https://example.com/hook', ['invoice.created']));
      const fetched = await store.get(ep.id);
      expect(fetched).toEqual(ep);
    });

    it('returns undefined for an unknown id', async () => {
      const result = await store.get('non-existent-id');
      expect(result).toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns empty array when no endpoints exist', async () => {
      const list = await store.list();
      expect(list).toEqual([]);
    });

    it('returns all created endpoints', async () => {
      const ep1 = await store.create(noSecret('https://a.com', ['invoice.created']));
      const ep2 = await store.create(noSecret('https://b.com', ['payment.confirmed']));
      const list = await store.list();
      expect(list).toHaveLength(2);
      expect(list).toContainEqual(ep1);
      expect(list).toContainEqual(ep2);
    });
  });

  describe('delete', () => {
    it('removes the endpoint and returns true', async () => {
      const ep = await store.create(noSecret('https://example.com/hook', ['invoice.created']));
      const result = await store.delete(ep.id);
      expect(result).toBe(true);
      expect(await store.get(ep.id)).toBeUndefined();
    });

    it('returns false for an unknown id', async () => {
      const result = await store.delete('non-existent-id');
      expect(result).toBe(false);
    });

    it('removes only the specified endpoint', async () => {
      const ep1 = await store.create(noSecret('https://a.com', ['invoice.created']));
      const ep2 = await store.create(noSecret('https://b.com', ['invoice.created']));
      await store.delete(ep1.id);
      const list = await store.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(ep2);
    });

    it('returns false on second delete of same id', async () => {
      const ep = await store.create(noSecret('https://a.com', ['invoice.created']));
      await store.delete(ep.id);
      const second = await store.delete(ep.id);
      expect(second).toBe(false);
    });
  });

  describe('getByEventType', () => {
    it('returns endpoints subscribed to the given event type', async () => {
      const ep1 = await store.create(
        noSecret('https://a.com', ['invoice.created', 'payment.confirmed']),
      );
      const ep2 = await store.create(noSecret('https://b.com', ['payment.confirmed']));
      const ep3 = await store.create(noSecret('https://c.com', ['invoice.expired']));

      const results = await store.getByEventType('payment.confirmed');
      expect(results).toHaveLength(2);
      expect(results).toContainEqual(ep1);
      expect(results).toContainEqual(ep2);
      expect(results).not.toContainEqual(ep3);
    });

    it('returns empty array for an unsubscribed event type', async () => {
      await store.create(noSecret('https://a.com', ['invoice.created']));
      const results = await store.getByEventType('invoice.canceled');
      expect(results).toEqual([]);
    });

    it('returns empty array when store is empty', async () => {
      const results = await store.getByEventType('invoice.created');
      expect(results).toEqual([]);
    });

    it('returns all endpoints subscribed to a single event type', async () => {
      const ep1 = await store.create(noSecret('https://a.com', ['invoice.created']));
      const ep2 = await store.create(noSecret('https://b.com', ['invoice.created']));
      const results = await store.getByEventType('invoice.created');
      expect(results).toHaveLength(2);
      expect(results).toContainEqual(ep1);
      expect(results).toContainEqual(ep2);
    });

    it('does not include deleted endpoints', async () => {
      const ep = await store.create(noSecret('https://a.com', ['invoice.created']));
      await store.delete(ep.id);
      const results = await store.getByEventType('invoice.created');
      expect(results).toEqual([]);
    });
  });
});
