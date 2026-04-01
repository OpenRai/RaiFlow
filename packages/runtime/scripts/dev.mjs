#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { watch } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

function findWorkspaceRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const root = findWorkspaceRoot();
const watchTargets = [
  'packages/model/src',
  'packages/config/src',
  'packages/events/src',
  'packages/storage/src',
  'packages/rpc/src',
  'packages/custody/src',
  'packages/webhook/src',
  'packages/runtime/src',
  'raiflow.yaml',
];

const buildPackages = [
  '@openrai/model',
  '@openrai/config',
  '@openrai/events',
  '@openrai/storage',
  '@openrai/rpc',
  '@openrai/custody',
  '@openrai/webhook',
  '@openrai/runtime',
];

let runtimeProcess = null;
let rebuildTimer = null;
let rebuilding = false;
let queued = false;

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: false,
      env: process.env,
    });

    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${command} ${args.join(' ')} exited with ${signal ?? code}`));
    });
  });
}

async function buildRuntime() {
  for (const pkg of buildPackages) {
    await run('pnpm', ['--filter', pkg, 'build']);
  }
}

function stopRuntime() {
  return new Promise((resolvePromise) => {
    if (!runtimeProcess) {
      resolvePromise();
      return;
    }

    const child = runtimeProcess;
    runtimeProcess = null;

    child.once('exit', () => resolvePromise());
    child.kill('SIGTERM');

    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 3000).unref();
  });
}

function startRuntime() {
  runtimeProcess = spawn('pnpm', ['--filter', '@openrai/runtime', 'start'], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });

  runtimeProcess.on('exit', (code, signal) => {
    const expected = runtimeProcess === null;
    if (!expected) {
      console.log(`[runtime:dev] runtime exited with ${signal ?? code}`);
    }
  });
}

async function rebuildAndRestart(reason = 'initial startup') {
  if (rebuilding) {
    queued = true;
    return;
  }

  rebuilding = true;
  console.log(`[runtime:dev] rebuilding after ${reason}`);

  try {
    await buildRuntime();
    await stopRuntime();
    startRuntime();
    console.log('[runtime:dev] runtime restarted');
  } catch (error) {
    console.error('[runtime:dev] rebuild failed:', error instanceof Error ? error.message : error);
    console.error('[runtime:dev] keeping current runtime process as-is');
  } finally {
    rebuilding = false;
    if (queued) {
      queued = false;
      void rebuildAndRestart('queued change');
    }
  }
}

function scheduleRebuild(reason) {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    void rebuildAndRestart(reason);
  }, 200);
}

const watchers = watchTargets
  .map((target) => resolve(root, target))
  .filter((target) => existsSync(target))
  .map((target) => watch(target, { recursive: true }, (_eventType, filename) => {
    scheduleRebuild(filename ? `${target}/${filename}` : target);
  }));

process.on('SIGINT', async () => {
  for (const watcher of watchers) watcher.close();
  if (rebuildTimer) clearTimeout(rebuildTimer);
  await stopRuntime();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  for (const watcher of watchers) watcher.close();
  if (rebuildTimer) clearTimeout(rebuildTimer);
  await stopRuntime();
  process.exit(0);
});

void rebuildAndRestart();
