import { vi } from 'vitest';

vi.mock('nano-rspow-node', () => ({
  generateWork: vi.fn().mockResolvedValue('mockedwork0000000'),
  WorkType: { Send: 'send', Receive: 'receive' },
}));
