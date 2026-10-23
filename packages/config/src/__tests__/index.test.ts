import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, minimumReceiveAmountRaw } from '../index.js';

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'raiflow-config-'));
  const path = join(dir, 'raiflow.yml');
  writeFileSync(path, contents, 'utf8');
  return path;
}

const tempPaths: string[] = [];

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  delete process.env['RAIFLOW_MODE'];
  delete process.env['TEST_OWS_CREDENTIAL'];
  delete process.env['TEST_NANO_WORK_URL'];
  delete process.env['RAIFLOW_MINIMUM_RECEIVE_AMOUNT_XNO'];
  delete process.env['TEST_MINIMUM_XNO'];
  delete process.env['RAIFLOW_STORAGE_MAX_DATABASE_BYTES'];
  delete process.env['RAIFLOW_STORAGE_MAX_DEPOSITS_PER_ACCOUNT'];
  delete process.env['TEST_STORAGE_MAX_BYTES'];
});

describe('loadConfig receiving minimum', () => {
  it('defaults to one millionth XNO and converts exact decimal amounts', () => {
    const path = writeConfig('{}\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));
    expect(loadConfig(path).receiving.minimumAmountXno).toBe('0.000001');
    expect(minimumReceiveAmountRaw('0.000001')).toBe('1000000000000000000000000');
    expect(minimumReceiveAmountRaw('0.000000000000000000000000000001')).toBe('1');
  });

  it('resolves YAML env references and gives the dedicated env variable precedence', () => {
    process.env['TEST_MINIMUM_XNO'] = '0.005';
    const path = writeConfig('receiving:\n  minimumAmountXno: "env:TEST_MINIMUM_XNO"\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));
    expect(loadConfig(path).receiving.minimumAmountXno).toBe('0.005');
    process.env['RAIFLOW_MINIMUM_RECEIVE_AMOUNT_XNO'] = '0.01';
    expect(loadConfig(path).receiving.minimumAmountXno).toBe('0.01');
    process.env['RAIFLOW_MINIMUM_RECEIVE_AMOUNT_XNO'] = '';
    expect(() => loadConfig(path)).toThrow('positive decimal XNO string');
  });

  it.each(['0', '-1', '1e-6', 'NaN', '0.0000000000000000000000000000001', '340282367'])('rejects invalid minimum %s', (value) => {
    const path = writeConfig(`receiving:\n  minimumAmountXno: "${value}"\n`);
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));
    expect(() => loadConfig(path)).toThrow('positive decimal XNO string');
  });

  it('requires a quoted amount rather than a floating point YAML number', () => {
    const path = writeConfig('receiving:\n  minimumAmountXno: 0.001\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));
    expect(() => loadConfig(path)).toThrow('quoted decimal XNO string');
  });
});

describe('loadConfig storage budgets', () => {
  it('defaults to a bounded database and per-account deposit count', () => {
    const path = writeConfig('{}\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));
    expect(loadConfig(path).storage).toMatchObject({
      maxDatabaseBytes: 1_073_741_824,
      maxDepositsPerAccount: 100_000,
    });
  });

  it('accepts YAML and environment storage budget overrides', () => {
    const path = writeConfig([
      'storage:',
      '  maxDatabaseBytes: "env:TEST_STORAGE_MAX_BYTES"',
      '  maxDepositsPerAccount: 250',
      '',
    ].join('\n'));
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));
    process.env['TEST_STORAGE_MAX_BYTES'] = String(64 * 1024 * 1024);
    process.env['RAIFLOW_STORAGE_MAX_DEPOSITS_PER_ACCOUNT'] = '500';
    expect(loadConfig(path).storage).toMatchObject({
      maxDatabaseBytes: 64 * 1024 * 1024,
      maxDepositsPerAccount: 500,
    });
    delete process.env['TEST_STORAGE_MAX_BYTES'];
  });

  it.each(['0', '-1', '1.5', '9007199254740992'])('rejects invalid storage budgets %s', (value) => {
    const path = writeConfig(`storage:\n  maxDepositsPerAccount: "${value}"\n`);
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));
    expect(() => loadConfig(path)).toThrow('positive safe integer');
  });
});

describe('loadConfig nano transport arrays', () => {
  it('accepts an empty nano block', () => {
    const path = writeConfig('nano: {}\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    const config = loadConfig(path);
    expect(config.nano).toEqual({ rpc: [], ws: [], work: [] });
  });

  it('accepts flat rpc override list', () => {
    const path = writeConfig('nano:\n  rpc: ["https://rpc.example.com"]\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    const config = loadConfig(path);
    expect(config.nano).toEqual({ rpc: ['https://rpc.example.com'], ws: [], work: [] });
  });

  it('accepts flat rpc and ws override lists', () => {
    const path = writeConfig('nano:\n  rpc: ["https://rpc.example.com"]\n  ws: ["wss://ws.example.com"]\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    const config = loadConfig(path);
    expect(config.nano).toEqual({ rpc: ['https://rpc.example.com'], ws: ['wss://ws.example.com'], work: [] });
  });

  it('accepts configured work endpoints and resolves environment references', () => {
    process.env['TEST_NANO_WORK_URL'] = 'https://work.example.com';
    const path = writeConfig('nano:\n  work: ["env:TEST_NANO_WORK_URL"]\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    expect(loadConfig(path).nano.work).toEqual(['https://work.example.com']);
  });

  it('rejects invalid nano transport values', () => {
    const path = writeConfig('nano:\n  rpc: "https://rpc.example.com"\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    expect(() => loadConfig(path)).toThrow('config.nano.rpc must be an array of strings');
  });

  it('rejects invalid nano work endpoint values', () => {
    const path = writeConfig('nano:\n  work: "https://work.example.com"\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    expect(() => loadConfig(path)).toThrow('config.nano.work must be an array of strings');
  });
});

describe('loadConfig daemon.mode', () => {
  it('parses mode from YAML', () => {
    const path = writeConfig('daemon:\n  mode: "custodial"\nnano: {}\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    const config = loadConfig(path);
    expect(config.daemon.mode).toBe('custodial');
  });

  it('normalizes mode to lowercase', () => {
    const path = writeConfig('daemon:\n  mode: "Non-Custodial"\nnano: {}\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    const config = loadConfig(path);
    expect(config.daemon.mode).toBe('non-custodial');
  });

  it('RAIFLOW_MODE env var takes precedence over YAML', () => {
    process.env['RAIFLOW_MODE'] = 'non-custodial';
    const path = writeConfig('daemon:\n  mode: "custodial"\nnano: {}\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    const config = loadConfig(path);
    expect(config.daemon.mode).toBe('non-custodial');
  });

  it('mode is undefined when neither env var nor YAML is set', () => {
    const path = writeConfig('nano: {}\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    const config = loadConfig(path);
    expect(config.daemon.mode).toBeUndefined();
  });

  it('rejects invalid mode value', () => {
    const path = writeConfig('daemon:\n  mode: "invalid"\nnano: {}\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    expect(() => loadConfig(path)).toThrow('config.daemon.mode must be "custodial" or "non-custodial"');
  });
});

describe('loadConfig invoices.defaultExpirySeconds', () => {
  it('uses the one-hour default and rejects non-positive or fractional expiry durations', () => {
    const defaultPath = writeConfig('invoices: {}\n');
    tempPaths.push(defaultPath.replace(/\/raiflow\.yml$/, ''));
    expect(loadConfig(defaultPath).invoices.defaultExpirySeconds).toBe(3600);

    const invalidPath = writeConfig('invoices:\n  defaultExpirySeconds: 0.5\n');
    tempPaths.push(invalidPath.replace(/\/raiflow\.yml$/, ''));
    expect(() => loadConfig(invalidPath)).toThrow('positive integer');
  });
});

describe('loadConfig invoices.autoSweep', () => {
  it('validates the treasury address when auto-sweep is enabled', () => {
    const path = writeConfig('invoices:\n  autoSweep: true\n  sweepDestination: "nano_1treasury"\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));
    expect(() => loadConfig(path)).toThrow('valid Nano address');
  });
});

describe('loadConfig custody', () => {
  it('loads an OWS wallet reference and resolves its credential', () => {
    process.env['TEST_OWS_CREDENTIAL'] = 'ows_key_test';
    const path = writeConfig([
      'custody:',
      '  provider: ows',
      '  wallet: runtime-wallet',
      '  credential: env:TEST_OWS_CREDENTIAL',
      '  vaultPath: /secure/vault',
      '  representative: nano_1representative',
      '',
    ].join('\n'));
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    expect(loadConfig(path).custody).toEqual({
      provider: 'ows',
      wallet: 'runtime-wallet',
      credential: 'ows_key_test',
      vaultPath: '/secure/vault',
      representative: 'nano_1representative',
    });
  });

  it('rejects raw seed custody configuration', () => {
    const path = writeConfig([
      'custody:',
      '  seed: unsafe-seed',
      '  representative: nano_1representative',
      '',
    ].join('\n'));
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    expect(() => loadConfig(path)).toThrow('seed is no longer accepted');
  });
});
