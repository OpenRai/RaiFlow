import { afterEach, describe, expect, it, vi } from 'vitest';
import { NanoWebSocketClient } from '../websocket.js';

describe('NanoWebSocketClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests an acknowledged account-filtered subscription and waits for its matching ack', () => {
    vi.stubGlobal('WebSocket', { OPEN: 1 });
    const send = vi.fn();
    const handleConfirmedBlock = vi.fn().mockResolvedValue(undefined);
    const onSubscriptionAck = vi.fn();
    const client = new NanoWebSocketClient({ onSubscriptionAck });
    (client as any).ws = { readyState: 1, send };
    (client as any).watchedAccounts = new Set(['nano_account_a', 'nano_account_b']);
    (client as any).sink = { handleConfirmedBlock };

    (client as any).sendSubscription();
    const subscription = JSON.parse(send.mock.calls[0]![0] as string) as Record<string, any>;

    expect(subscription).toMatchObject({
      action: 'subscribe',
      topic: 'confirmation',
      ack: true,
      options: {
        all_local_accounts: false,
        accounts: ['nano_account_a', 'nano_account_b'],
      },
    });
    const confirmation = JSON.stringify({
      topic: 'confirmation',
      message: {
        account: 'nano_sender',
        amount: '10',
        hash: 'source-hash',
        block: { type: 'state', subtype: 'send', link_as_account: 'nano_account_a' },
      },
    });
    (client as any).handleMessage(confirmation);
    expect(handleConfirmedBlock).not.toHaveBeenCalled();

    (client as any).handleMessage(JSON.stringify({ ack: 'subscribe', id: 'unrelated-request' }));
    expect(onSubscriptionAck).not.toHaveBeenCalled();
    (client as any).handleMessage(JSON.stringify({ ack: 'subscribe', id: subscription.id }));
    expect(onSubscriptionAck).toHaveBeenCalledTimes(1);
    (client as any).handleMessage(confirmation);
    expect(handleConfirmedBlock).toHaveBeenCalledWith(expect.objectContaining({ blockHash: 'source-hash' }));
    (client as any).handleMessage(JSON.stringify({
      topic: 'confirmation',
      message: {
        account: 'nano_account_a',
        amount: '10',
        hash: 'outgoing-source-hash',
        block: { type: 'state', subtype: 'send', link_as_account: 'nano_external' },
      },
    }));
    expect(handleConfirmedBlock).toHaveBeenCalledTimes(1);
  });
});
