// `modulus update` — pull latest code and rebuild.
//
// Resolves the repo root relative to this file (works from dist/ or src/).
// Runs: git pull → npm install → npm run build.

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function run(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..', '..');

  // Guard: refuse to `git pull` somewhere that isn't a Modulus checkout. The
  // resolved root walks two levels up from this file's runtime location; if
  // the binary is installed in an odd place (npm global, packaged release) we
  // don't want to attempt git in whatever sibling directory we end up at.
  if (!existsSync(join(root, '.git'))) {
    process.stderr.write(
      `Refusing to update: ${root} is not a git checkout.\n` +
        `Re-clone the repo or reinstall Modulus instead.\n`,
    );
    process.exit(1);
  }

  process.stdout.write('Pulling latest changes…\n');
  execSync('git pull', { cwd: root, stdio: 'inherit' });

  process.stdout.write('\nInstalling dependencies…\n');
  execSync('npm install', { cwd: root, stdio: 'inherit' });

  process.stdout.write('\nBuilding…\n');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });

  process.stdout.write('\n✓ Modulus updated. Run `modulus start` to launch the new version.\n');
}
