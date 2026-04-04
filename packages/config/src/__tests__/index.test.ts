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

  it('accepts flat rpc, ws, and work override lists', () => {
    const path = writeConfig('nano:\n  rpc: ["https://rpc.example.com"]\n  ws: ["wss://ws.example.com"]\n  work: ["https://work.example.com"]\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    const config = loadConfig(path);
    expect(config.nano).toEqual({ rpc: ['https://rpc.example.com'], ws: ['wss://ws.example.com'], work: ['https://work.example.com'] });
  });

  it('rejects invalid nano transport values', () => {
    const path = writeConfig('nano:\n  rpc: "https://rpc.example.com"\n');
    tempPaths.push(path.replace(/\/raiflow\.yml$/, ''));

    expect(() => loadConfig(path)).toThrow('config.nano.rpc must be an array of strings');
  });
});
