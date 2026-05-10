import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(dir, '..', 'dist');
const outPath = resolve(outDir, 'VERSION');

let describe = 'unknown';
const envVersion = process.env['RAIFLOW_VERSION'];
if (envVersion) {
  describe = envVersion.replace(/^git:/, '');
} else {
  try {
    describe = execSync('git describe --tags --always', { encoding: 'utf-8' }).trim();
  } catch { /* no git available */ }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, `git:${describe}\n`, 'utf-8');