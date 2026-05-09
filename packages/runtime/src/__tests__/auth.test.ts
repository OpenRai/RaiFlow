// @openrai/runtime — auth tests

import { describe, it, expect, afterEach } from 'vitest';
import { resolveApiKey } from '../auth.js';
import { createTestConfig } from './helpers.js';

describe('resolveApiKey', () => {
  const originalEnv = process.env['RAIFLOW_API_KEY'];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['RAIFLOW_API_KEY'];
    } else {
      process.env['RAIFLOW_API_KEY'] = originalEnv;
    }
  });

  it('returns env var key when RAIFLOW_API_KEY is set', () => {
    process.env['RAIFLOW_API_KEY'] = 'env-key-123';
    const config = createTestConfig();
    const result = resolveApiKey(config);
    expect(result.apiKey).toBe('env-key-123');
    expect(result.source).toBe('env');
  });

  it('returns config key when daemon.apiKey is set and no env var', () => {
    delete process.env['RAIFLOW_API_KEY'];
    const config = createTestConfig({ apiKey: 'my-secret-key' });
    const result = resolveApiKey(config);
    expect(result.apiKey).toBe('my-secret-key');
    expect(result.source).toBe('config');
  });

  it('env var takes precedence over config key', () => {
    process.env['RAIFLOW_API_KEY'] = 'env-wins';
    const config = createTestConfig({ apiKey: 'config-key' });
    const result = resolveApiKey(config);
    expect(result.apiKey).toBe('env-wins');
    expect(result.source).toBe('env');
  });

  it('throws when neither env var nor config key is set', () => {
    delete process.env['RAIFLOW_API_KEY'];
    const config = createTestConfig();
    expect(() => resolveApiKey(config)).toThrow('RAIFLOW_API_KEY is required');
  });
});
