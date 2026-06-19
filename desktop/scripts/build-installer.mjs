// Build the distributable installer:
//
//   1. stage the daemon payload (skip with --skip-stage if already staged)
//   2. dotnet publish the WinUI shell (self-contained win-x64)
//   3. copy staging/daemon into the publish folder
//   4. vpk pack → desktop/Releases/Modulus-win-Setup.exe
//
// Requires the vpk dotnet tool (local manifest): `dotnet tool restore` in desktop/.

import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
// Desktop release version tracks the repo package.json so the installer matches
// the project version; override with MODULUS_DESKTOP_VERSION. vpk aborts unless
// this is past the latest in desktop/Releases.
const VERSION =
  process.env.MODULUS_DESKTOP_VERSION ??
  JSON.parse(readFileSync(join(desktop, '..', 'package.json'), 'utf8')).version;
const project = join(desktop, 'ModulusDesktop', 'ModulusDesktop.csproj');
const publishDir = join(desktop, 'publish');
const stagingDaemon = join(desktop, 'staging', 'daemon');
const releases = join(desktop, 'Releases');

function run(cmd, args, cwd = desktop) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} failed with code ${r.status}`);
}

if (!process.argv.includes('--skip-stage')) {
  execFileSync(process.execPath, [join(here, 'stage-daemon.mjs')], { stdio: 'inherit' });
} else if (!existsSync(join(stagingDaemon, 'node', 'node.exe'))) {
  throw new Error('--skip-stage given but staging/daemon is incomplete — run stage-daemon.mjs');
}

console.log('publishing shell …');
rmSync(publishDir, { recursive: true, force: true });
run('dotnet', [
  'publish',
  project,
  '-c',
  'Release',
  '-r',
  'win-x64',
  '-p:Platform=x64',
  '--self-contained',
  '-o',
  publishDir,
]);

console.log('copying daemon payload into publish …');
cpSync(stagingDaemon, join(publishDir, 'daemon'), { recursive: true });

console.log('packing installer …');
// Code signing is opt-in: set MODULUS_SIGN_PARAMS to the signtool.exe
// arguments (e.g. the Azure Trusted Signing dlib invocation) and vpk signs
// every exe it packs. Unset — the default until a signing account exists —
// produces the unsigned build (SmartScreen: "More info → Run anyway").
const signParams = process.env.MODULUS_SIGN_PARAMS;
run('dotnet', [
  'tool',
  'run',
  'vpk',
  '--',
  'pack',
  '--packId',
  'Modulus',
  '--packVersion',
  VERSION,
  '--packDir',
  publishDir,
  '--mainExe',
  'ModulusDesktop.exe',
  '--packTitle',
  'Modulus',
  '--icon',
  join(desktop, 'ModulusDesktop', 'Assets', 'icon.ico'),
  '--outputDir',
  releases,
  ...(signParams ? ['--signParams', signParams] : []),
]);

console.log(`done — installer in ${releases}`);
