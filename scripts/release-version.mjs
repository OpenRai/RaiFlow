import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const packagePaths = [
  'packages/model/package.json',
  'packages/webhook/package.json',
  'packages/raiflow-sdk/package.json',
];

function readVersions() {
  return new Map(
    packagePaths.map((relativePath) => {
      const pkg = JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
      return [pkg.name, pkg.version];
    }),
  );
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

const before = readVersions();

run('pnpm', ['changeset', 'version']);

const after = readVersions();
const changed = [];

for (const [name, version] of after.entries()) {
  if (before.get(name) !== version) {
    changed.push({ name, version });
  }
}

if (changed.length === 0) {
  console.log('[release-version] No package versions changed.');
  process.exit(0);
}

run('git', ['add', '.changeset', 'packages/model/package.json', 'packages/webhook/package.json', 'packages/raiflow-sdk/package.json', 'pnpm-lock.yaml']);

const summary = changed.map(({ name, version }) => `${name}@${version}`).join(', ');
run('git', ['commit', '-m', `release: ${summary}`]);

for (const { name, version } of changed) {
  run('git', ['tag', `${name}@${version}`]);
}

console.log(`[release-version] Created commit and tags for: ${summary}`);
console.log('[release-version] Push with: git push && git push --tags');
