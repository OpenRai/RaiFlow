import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

const publishedPackages = [
  '@openrai/model',
  '@openrai/webhook',
  '@openrai/raiflow-sdk',
];

function readVersions(packages) {
  return new Map(
    packages.map((name) => {
      const pkgPath = resolve(root, `packages/${name.replace('@openrai/', '')}/package.json`);
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      return [pkg.name, pkg.version];
    }),
  );
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function getVersion(versions) {
  const uniqueVersions = [...new Set(versions.values())];
  if (uniqueVersions.length !== 1) {
    const detail = [...versions.entries()].map(([name, version]) => `${name}@${version}`).join(', ');
    throw new Error(`[release:version] Expected lockstep versions, got: ${detail}`);
  }
  return uniqueVersions[0];
}

const before = readVersions(publishedPackages);
const beforeVersions = [...new Set(before.values())];

run('pnpm', ['changeset', 'version']);

const after = readVersions(publishedPackages);
const afterVersion = getVersion(after);

if (beforeVersions.length === 1 && beforeVersions[0] === afterVersion) {
  console.log('[release:version] No package versions changed.');
  process.exit(0);
}

const changesetFiles = ['.changeset'];
const changedPackages = new Set();

for (const [name, version] of after) {
  changedPackages.add(name);
}

const packageDirs = [
  'packages/model',
  'packages/webhook',
  'packages/raiflow-sdk',
  'packages/config',
  'packages/custody',
  'packages/events',
  'packages/rpc',
  'packages/runtime',
  'packages/storage',
  'packages/watcher',
];

for (const dir of packageDirs) {
  changesetFiles.push(`${dir}/package.json`);
}
changesetFiles.push('pnpm-lock.yaml');

run('git', ['add', ...changesetFiles]);

const summary = [...changedPackages].map((n) => `${n}@${afterVersion}`).join(', ');
run('git', ['commit', '-m', `release: ${summary}`]);

for (const name of publishedPackages) {
  run('git', ['tag', `${name}@${afterVersion}`]);
}

console.log(`\n[release:version] Commit and tags created for: ${summary}`);
console.log('[release:version] Run: git push && git push --tags\n');
console.log('Trusted Publishers will detect the tags and publish to npm automatically.\n');