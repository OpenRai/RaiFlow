// @openrai/runtime — API key resolution, auto-generation, and file storage

import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import type { RaiFlowConfig } from '@openrai/config';

export interface ApiKeyResolution {
  /** The effective API key string. */
  apiKey: string;
  /** Where the key came from. */
  source: 'config' | 'file' | 'generated';
}

/**
 * Resolve the effective API key for the runtime.
 *
 * 1. If `config.daemon.apiKey` is set (via env or YAML), use it.
 * 2. If a previously-generated key file exists next to the database, read it.
 * 3. Otherwise, generate a new 256-bit random hex key and persist it.
 *
 * The key file is written to `<dirname(config.storage.path)>/.api-key` so it
 * lives on the same persistent volume as the SQLite database.
 */
export function resolveApiKey(config: RaiFlowConfig): ApiKeyResolution {
  const configuredKey = config.daemon.apiKey;
  if (configuredKey) {
    return { apiKey: configuredKey, source: 'config' };
  }

  const keyFilePath = resolve(dirname(config.storage.path), '.api-key');

  if (existsSync(keyFilePath)) {
    const existingKey = readFileSync(keyFilePath, 'utf-8').trim();
    if (existingKey) {
      return { apiKey: existingKey, source: 'file' };
    }
  }

  const newKey = randomBytes(32).toString('hex');
  const keyDir = dirname(keyFilePath);
  if (!existsSync(keyDir)) {
    mkdirSync(keyDir, { recursive: true });
  }
  writeFileSync(keyFilePath, newKey, 'utf-8');

  return { apiKey: newKey, source: 'generated' };
}

/**
 * Return the filesystem path where the API key would be stored.
 * Useful for CLI tools that want to read the key directly.
 */
export function getApiKeyFilePath(config: RaiFlowConfig): string {
  return resolve(dirname(config.storage.path), '.api-key');
}
