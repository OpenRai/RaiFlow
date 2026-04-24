import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const publishedPackages = [
  ['@openrai/model', 'packages/model/package.json'],
  ['@openrai/webhook', 'packages/webhook/package.json'],
  ['@openrai/raiflow-sdk', 'packages/raiflow-sdk/package.json'],
];

function readVersions() {
  return new Map(
    publishedPackages.map(([name, relativePath]) => {
      const pkg = JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
      if (pkg.name !== name) {
        throw new Error(`Package manifest mismatch for ${relativePath}: expected ${name}, got ${pkg.name}`);
      }
      return [pkg.name, pkg.version];
    }),
  );
}

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function getSingleReleaseVersion(versions, label) {
  const uniqueVersions = [...new Set(versions.values())];
  if (uniqueVersions.length !== 1) {
    const detail = [...versions.entries()].map(([name, version]) => `${name}@${version}`).join(', ');
    throw new Error(`[release-version] Expected lockstep versions ${label}, got: ${detail}`);
  }
  return uniqueVersions[0];
}

const before = readVersions();
const beforeVersions = [...new Set(before.values())];

run('pnpm', ['changeset', 'version']);

const after = readVersions();
const afterVersion = getSingleReleaseVersion(after, 'after versioning');

if (beforeVersions.length === 1 && beforeVersions[0] === afterVersion) {
  console.log('[release-version] No package versions changed.');
  process.exit(0);
}

run('git', ['add', '.changeset', 'packages/model/package.json', 'packages/webhook/package.json', 'packages/raiflow-sdk/package.json', 'pnpm-lock.yaml']);

const summary = publishedPackages.map(([name]) => `${name}@${afterVersion}`).join(', ');
run('git', ['commit', '-m', `release: ${summary}`]);

for (const [name] of publishedPackages) {
  run('git', ['tag', `${name}@${afterVersion}`]);
}

console.log(`[release-version] Created commit and tags for: ${summary}`);
console.log('[release-version] Push with: git push && git push --tags');
