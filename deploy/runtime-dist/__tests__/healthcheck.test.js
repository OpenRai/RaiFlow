import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
const execFileAsync = promisify(execFile);
const script = new URL('../../docker/healthcheck.mjs', import.meta.url);
const servers = [];
afterEach(() => {
    for (const server of servers.splice(0))
        server.close();
});
function listen(handler) {
    const server = createServer(handler);
    servers.push(server);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string')
                throw new Error('test server did not bind a TCP port');
            resolve({ server, url: `http://127.0.0.1:${address.port}/health/live` });
        });
    });
}
describe('Docker liveness probe', () => {
    it('accepts a responsive loopback health endpoint', async () => {
        const { url } = await listen((_req, response) => {
            response.writeHead(200).end(JSON.stringify({ status: 'ok' }));
        });
        await expect(execFileAsync(process.execPath, [script.pathname], { env: { ...process.env, RAIFLOW_HEALTH_URL: url, RAIFLOW_HEALTH_TIMEOUT_MS: '250' } })).resolves.toBeDefined();
    });
    it('rejects a non-success health response', async () => {
        const { url } = await listen((_req, response) => response.writeHead(503).end());
        await expect(execFileAsync(process.execPath, [script.pathname], { env: { ...process.env, RAIFLOW_HEALTH_URL: url, RAIFLOW_HEALTH_TIMEOUT_MS: '250' } })).rejects.toMatchObject({ code: 1 });
    });
    it('fails within the probe deadline when the runtime is unresponsive', async () => {
        const { url } = await listen((_req, response) => {
            setTimeout(() => response.writeHead(200).end(), 500);
        });
        const started = Date.now();
        const probe = execFileAsync(process.execPath, [script.pathname], { env: { ...process.env, RAIFLOW_HEALTH_URL: url, RAIFLOW_HEALTH_TIMEOUT_MS: '40' } });
        await expect(probe).rejects.toMatchObject({ code: 1 });
        expect(Date.now() - started).toBeLessThan(300);
    });
});
//# sourceMappingURL=healthcheck.test.js.map