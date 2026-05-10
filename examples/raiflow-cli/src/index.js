#!/usr/bin/env node
import chalk from 'chalk';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { RaiFlowClient } from '@openrai/raiflow-sdk';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function loadEnv() {
  const envPath = resolve(__dirname, '.env');
  try {
    const content = readFileSync(envPath, 'utf-8');
    const env = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      env[key] = val;
    }
    return env;
  } catch {
    return {};
  }
}

const env = { ...process.env, ...loadEnv() };

const BASE_URL = env.RAIFLOW_API_URL ?? env.RAIFLOW_BASE_URL ?? 'http://localhost:3100';
const API_KEY = env.RAIFLOW_API_KEY ?? '';

const client = RaiFlowClient.initialize({ baseUrl: BASE_URL, apiKey: API_KEY });

async function cmdHealth() {
  console.log(chalk.bold('\n  RaiFlow Health Check\n'));
  console.log(chalk.dim(`  Target: ${BASE_URL}\n`));

  let ok = false;
  let latency = 0;

  try {
    const t0 = Date.now();
    const result = await client.system.health();
    latency = Date.now() - t0;

    console.log(`  ${chalk.green('●')} API reachable`);
    console.log(`    Status  : ${chalk.green(result.status)}`);
    console.log(`    Latency : ${chalk.cyan(`${latency}ms`)}`);
    ok = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${chalk.red('●')} Health check failed`);
    console.log(`    ${chalk.red(msg)}`);
  }

  console.log(chalk.dim('\n  ─────────────────────\n'));
  process.exit(ok ? 0 : 1);
}

async function cmdVersion() {
  console.log(chalk.bold('\n  RaiFlow Version\n'));
  console.log(chalk.dim(`  Target: ${BASE_URL}\n`));

  let ok = false;

  try {
    const runtimeResult = await client.system.version();

    console.log(`  ${chalk.green('●')} Runtime version`);
    console.log(`    ${chalk.cyan(runtimeResult.version)}`);
    ok = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${chalk.red('●')} Version check failed`);
    console.log(`    ${chalk.red(msg)}`);
  }

  console.log(chalk.dim('\n  ─────────────────────\n'));
  process.exit(ok ? 0 : 1);
}

const [,, subcommand = 'health'] = process.argv;

const commands = { health: cmdHealth, version: cmdVersion };

if (commands[subcommand]) {
  commands[subcommand]();
} else {
  console.log(chalk.red(`Unknown command: ${subcommand}`));
  console.log(chalk.dim(`Usage: raiflow <health|version>`));
  process.exit(1);
}