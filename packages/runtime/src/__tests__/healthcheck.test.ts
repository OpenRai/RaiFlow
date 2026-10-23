import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-ignore The CLI helper is plain JavaScript and intentionally has no declaration file.
import { probeHealth } from '../../docker/healthcheck.mjs';

const execFileAsync = promisify(execFile);
const script = new URL('../../docker/healthcheck.mjs', import.meta.url);

const servers: ReturnType<typeof createServer>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
      resolve({ server, url: `http://127.0.0.1:${address.port}/health/live` });
    });
  });
}

describe('Docker liveness probe', () => {
  it('accepts a responsive loopback health endpoint', async () => {
    const { url } = await listen((_req, response) => {
      response.writeHead(200).end(JSON.stringify({ status: 'ok' }));
    });
    await expect(execFileAsync(process.execPath, [script.pathname], { env: { ...process.env, RAIFLOW_HEALTH_URL: url, RAIFLOW_HEALTH_TIMEOUT_MS: '5000' } })).resolves.toBeDefined();
  });

  it('rejects a non-success health response', async () => {
    const { url } = await listen((_req, response) => response.writeHead(503).end());
    await expect(execFileAsync(process.execPath, [script.pathname], { env: { ...process.env, RAIFLOW_HEALTH_URL: url, RAIFLOW_HEALTH_TIMEOUT_MS: '5000' } })).rejects.toMatchObject({ code: 1 });
  });

  it('fails within the probe deadline when the runtime is unresponsive', async () => {
    const fetchImpl: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    });
    const started = Date.now();
    await expect(probeHealth('http://127.0.0.1/unresponsive', 40, fetchImpl)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(300);
  });
});
