import { describe, expect, it, vi } from 'vitest';
import { NanoPoller } from '../poller.js';
import type { NanoRpcClient } from '../rpc.js';
import type { WatcherSink } from '@openrai/model';

vi.mock('nano-rspow-node', () => ({
  generateWork: vi.fn().mockResolvedValue('test-work'),
  WorkType: { Send: 'Send', Receive: 'Receive', Epoch1: 'Epoch1', Dev: 'Dev' },
}));

describe('NanoPoller', () => {
  const receivableVariants = [
    {
      label: 'object (threshold)',
      value: {
        'nano_1account': {
          'ABC123': '1000000',
          'DEF456': '2000000',
        },
      },
    },
    {
      label: 'array (traditional)',
      value: {
        'nano_1account': ['ABC123', 'DEF456'],
      },
    },
  ];

  for (const { label, value } of receivableVariants) {
    it(`handles accounts_receivable response as ${label}`, async () => {
      const mockRpc = {
        accountsReceivable: vi.fn().mockResolvedValue(value),
        blockInfo: vi.fn().mockResolvedValue({
          confirmed: true,
          subtype: 'send',
          blockAccount: 'nano_sender',
          amount: '1000000',
          contents: {
            linkAsAccount: 'nano_1account',
          },
        }),
      } as unknown as NanoRpcClient;

      const mockSink = {
        handleConfirmedBlock: vi.fn().mockResolvedValue(undefined),
      } as unknown as WatcherSink;

      const poller = new NanoPoller({
        rpc: mockRpc,
        accounts: ['nano_1account'],
        intervalMs: 1000,
      });

      poller.start(mockSink);
      // Let the start() immediate sweep finish before explicitly invoking the
      // private method; the poller deliberately rejects overlapping sweeps.
      await new Promise((resolve) => setTimeout(resolve, 0));
      // @ts-ignore - access private method for testing
      await poller.poll();

      expect(mockRpc.blockInfo).toHaveBeenCalledWith('ABC123');
      expect(mockRpc.blockInfo).toHaveBeenCalledWith('DEF456');
      expect(mockSink.handleConfirmedBlock).toHaveBeenCalled();
    });
  }
});
