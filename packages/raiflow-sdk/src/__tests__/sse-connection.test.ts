import { afterEach, describe, expect, it, vi } from 'vitest';
import { SseConnection } from '../sse-connection.js';

function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.close(); } });
}

describe('SseConnection', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('re-subscribes watched addresses when an idle stream reconnects', async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    let streamNumber = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      urls.push(String(input));
      streamNumber += 1;
      return new Response(closedStream(), {
        headers: { 'X-Raiflow-Stream-Id': `stream-${streamNumber}` },
      });
    });

    const connection = new SseConnection('https://raiflow.example', '/v1', 'test-key');
    await connection.getStreamId();
    connection.watch('nano_1watched');

    await vi.advanceTimersByTimeAsync(2_000);

    expect(urls[0]).toBe('https://raiflow.example/v1/accounts/stream');
    expect(urls[1]).toContain('accounts=nano_1watched');
    connection.disconnect();
  });
});
