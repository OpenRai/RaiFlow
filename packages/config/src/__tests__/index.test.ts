import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../index.js';

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
});

describe('loadConfig nano transport arrays', () => {
  it('accepts an empty nano block', () => {
    const path = writeConfig('nano: {}\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    const config = loadConfig(path);
    expect(config.nano).toEqual({ rpc: [], ws: [] });
  });

  it('accepts flat rpc override list', () => {
    const path = writeConfig('nano:\n  rpc: ["https://rpc.example.com"]\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    const config = loadConfig(path);
    expect(config.nano).toEqual({ rpc: ['https://rpc.example.com'], ws: [] });
  });

  it('accepts flat rpc and ws override lists', () => {
    const path = writeConfig('nano:\n  rpc: ["https://rpc.example.com"]\n  ws: ["wss://ws.example.com"]\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    const config = loadConfig(path);
    expect(config.nano).toEqual({ rpc: ['https://rpc.example.com'], ws: ['wss://ws.example.com'] });
  });

  it('rejects invalid nano transport values', () => {
    const path = writeConfig('nano:\n  rpc: "https://rpc.example.com"\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    expect(() => loadConfig(path)).toThrow('config.nano.rpc must be an array of strings');
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
