#!/usr/bin/env node
// @openrai/runtime — CLI to retrieve the effective API key

import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@openrai/config';
import { resolveApiKey } from './auth.js';

function findWorkspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const WORKSPACE_ROOT = findWorkspaceRoot();
const CONFIG_PATH = resolve(WORKSPACE_ROOT, process.env['RAIFLOW_CONFIG_PATH'] ?? 'raiflow.yml');

let config;
try {
  config = loadConfig(CONFIG_PATH);
} catch (err) {
  console.error(`[raiflow] failed to load config from ${CONFIG_PATH}:`, err instanceof Error ? err.message : err);
  process.exit(1);
}

const { apiKey } = resolveApiKey(config);
console.log(apiKey);
