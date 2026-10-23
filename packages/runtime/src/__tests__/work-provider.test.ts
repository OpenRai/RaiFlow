import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PowEngine } from '@openrai/nano-core';
import { createRuntimeWorkProvider } from '../work-provider.js';

function localEngine(): PowEngine {
  return {
    name: 'test-local',
    generate: vi.fn().mockResolvedValue('local-work'),
    validate: vi.fn().mockReturnValue(true),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['NANO_WORK_URL'];
});

describe('runtime work provider', () => {
  it('uses local work when no remote endpoint is configured', async () => {
    const engine = localEngine();
    const work = createRuntimeWorkProvider([], engine);

    await expect(work.generate('11'.repeat(32), 'send')).resolves.toBe('local-work');
    expect(engine.generate).toHaveBeenCalledWith('11'.repeat(32), 'fffffff800000000');
    expect(engine.validate).toHaveBeenCalledWith('11'.repeat(32), 'local-work', 'fffffff800000000');
  });

  it('uses configured remote work and validates the nonce against the local engine', async () => {
    const engine = localEngine();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ work: 'remote-work' }));
    vi.stubGlobal('fetch', fetchMock);
    const work = createRuntimeWorkProvider(['https://work.example.com'], engine);

    await expect(work.generate('22'.repeat(32), 'receive')).resolves.toBe('remote-work');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'work_generate',
          hash: '22'.repeat(32),
          difficulty: 'fffffe0000000000',
        }),
      }),
    );
    expect(engine.generate).not.toHaveBeenCalled();
    expect(engine.validate).toHaveBeenCalledWith('22'.repeat(32), 'remote-work', 'fffffe0000000000');
  });

  it('falls back to local work when the configured remote endpoint fails', async () => {
    const engine = localEngine();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('remote unavailable')));
    const work = createRuntimeWorkProvider(['https://work.example.com'], engine);

    await expect(work.generate('33'.repeat(32), 'send')).resolves.toBe('local-work');
    expect(engine.generate).toHaveBeenCalledWith('33'.repeat(32), 'fffffff800000000');
    expect(engine.validate).toHaveBeenLastCalledWith('33'.repeat(32), 'local-work', 'fffffff800000000');
    expect(work.getAuditReport().lastGenerationTrace).toMatchObject({
      mode: 'local',
      fallbackFromRemote: true,
    });
  });
});
