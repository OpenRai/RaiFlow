// @openrai/runtime — SubscriptionManager tests

import { describe, it, expect } from 'vitest';
import { SubscriptionManager, type SSEController } from '../subscription-manager.js';
import type { AccountEvent } from '@openrai/model';

function createMockController(id: string): SSEController & { closed: boolean } {
  return {
    id,
    enqueue: () => {},
    close: () => {},
    closed: false,
  };
}

function makeEvent(address: string): AccountEvent {
  return {
    id: 'evt-1',
    type: 'account.balance_updated',
    accountId: 'acc-1',
    accountAddress: address,
    timestamp: new Date().toISOString(),
    data: { newBalanceRaw: '1000' },
  };
}

describe('SubscriptionManager', () => {
  it('fans out events to subscribed connections', () => {
    const mgr = new SubscriptionManager();
    const c1 = createMockController('c1');
    const events: string[] = [];
    c1.enqueue = (e) => events.push(e);

    mgr.subscribe('nano_1a', c1);
    mgr.publish(makeEvent('nano_1a'));

    expect(events).toHaveLength(1);
    expect(events[0]).toContain('account.balance_updated');
  });

  it('does not fan out to unsubscribed addresses', () => {
    const mgr = new SubscriptionManager();
    const c1 = createMockController('c1');
    const events: string[] = [];
    c1.enqueue = (e) => events.push(e);

    mgr.subscribe('nano_1a', c1);
    mgr.publish(makeEvent('nano_1b'));

    expect(events).toHaveLength(0);
  });

  it('deduplicates — one event per connection even if double-subscribed', () => {
    const mgr = new SubscriptionManager();
    const c1 = createMockController('c1');
    const events: string[] = [];
    c1.enqueue = (e) => events.push(e);

    mgr.subscribe('nano_1a', c1);
    mgr.subscribe('nano_1a', c1); // idempotent in Set
    mgr.publish(makeEvent('nano_1a'));

    expect(events).toHaveLength(1);
  });

  it('cleans up closed connections', () => {
    const mgr = new SubscriptionManager();
    const c1 = createMockController('c1');
    c1.closed = true;

    mgr.subscribe('nano_1a', c1);
    mgr.removeConnection(c1);

    expect(mgr.hasSubscribers('nano_1a')).toBe(false);
    expect(mgr.getConnection('c1')).toBeUndefined();
  });

  it('unsubscribe removes only the specified connection', () => {
    const mgr = new SubscriptionManager();
    const c1 = createMockController('c1');
    const c2 = createMockController('c2');

    mgr.subscribe('nano_1a', c1);
    mgr.subscribe('nano_1a', c2);
    mgr.unsubscribe('nano_1a', c1);

    expect(mgr.hasSubscribers('nano_1a')).toBe(true);
  });
});
