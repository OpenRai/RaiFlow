// @openrai/runtime — auth tests

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveApiKey, getApiKeyFilePath } from '../auth.js';
import type { RaiFlowConfig } from '@openrai/config';

function createMinimalConfig(overrides?: Partial<RaiFlowConfig['daemon']>): RaiFlowConfig {
  return {
    daemon: {
      host: '0.0.0.0',
      port: 3100,
      ...overrides,
    },
    nano: { rpc: [], ws: [], work: [] },
    custody: null,
    invoices: { defaultExpirySeconds: 3600, autoSweep: false, sweepDestination: null },
    storage: { driver: 'sqlite', path: './raiflow.db' },
    webhooks: [],
    logging: { level: 'info', format: 'pretty' },
  };
}

describe('resolveApiKey', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'raiflow-auth-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns config key when daemon.apiKey is set', () => {
    const config = createMinimalConfig({ apiKey: 'my-secret-key' });
    const result = resolveApiKey(config);
    expect(result.apiKey).toBe('my-secret-key');
    expect(result.source).toBe('config');
  });

  it('reads existing key from file when no config key is set', () => {
    const dbPath = join(tempDir, 'raiflow.db');
    const keyPath = join(tempDir, '.api-key');
    writeFileSync(keyPath, 'file-stored-key', 'utf-8');

    const config = createMinimalConfig();
    config.storage.path = dbPath;

    const result = resolveApiKey(config);
    expect(result.apiKey).toBe('file-stored-key');
    expect(result.source).toBe('file');
  });

  it('generates a new 64-char hex key when no config key and no file exists', () => {
    const dbPath = join(tempDir, 'raiflow.db');

    const config = createMinimalConfig();
    config.storage.path = dbPath;

    const result = resolveApiKey(config);
    expect(result.source).toBe('generated');
    expect(result.apiKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('persists generated key to the .api-key file', () => {
    const dbPath = join(tempDir, 'raiflow.db');
    const keyPath = join(tempDir, '.api-key');

    const config = createMinimalConfig();
    config.storage.path = dbPath;

    const result = resolveApiKey(config);
    expect(existsSync(keyPath)).toBe(true);
    expect(readFileSync(keyPath, 'utf-8')).toBe(result.apiKey);
  });

  it('returns the same key on subsequent calls (idempotent)', () => {
    const dbPath = join(tempDir, 'raiflow.db');

    const config = createMinimalConfig();
    config.storage.path = dbPath;

    const first = resolveApiKey(config);
    const second = resolveApiKey(config);

    expect(first.apiKey).toBe(second.apiKey);
    expect(first.source).toBe('generated');
    expect(second.source).toBe('file');
  });
});

describe('getApiKeyFilePath', () => {
  it('returns path next to the database', () => {
    const config = createMinimalConfig();
    config.storage.path = '/data/raiflow.db';
    expect(getApiKeyFilePath(config)).toBe('/data/.api-key');
  });
});
