// A friendly hint for the single most common install/npx wall: better-sqlite3's
// native binary failing to load. It happens when no prebuilt binary matched the
// user's Node version/platform and there's no C/C++ toolchain to compile one —
// the exact trap CLAUDE.md documents on this dev box. The raw node error
// ("NODE_MODULE_VERSION mismatch", "invalid ELF header", "Could not locate the
// bindings file") is opaque to an everyday user, so the CLI appends this guidance.
//
// Pure (string in, string|null out) so it lives apart from the CLI entrypoint and
// is unit-tested without booting the program. Returns null for unrelated errors,
// so a normal failure keeps its normal message.

const NATIVE_FAILURE_SIGNATURES = [
  'node_module_version',
  'compiled against a different node',
  'could not locate the bindings file',
  'invalid elf header',
  'not a valid win32 application',
  'dlopen',
  'better_sqlite3.node',
  'bindings file',
];

export function betterSqliteHint(message: string): string | null {
  const m = message.toLowerCase();
  const mentionsModule = m.includes('better-sqlite3') || m.includes('better_sqlite3');
  const missing = /cannot find module ['"]better-sqlite3/.test(m);
  const nativeLoadFailure = mentionsModule && NATIVE_FAILURE_SIGNATURES.some((s) => m.includes(s));
  if (!missing && !nativeLoadFailure) return null;

  return [
    '',
    "Modulus's database engine (better-sqlite3) could not load a native binary for your system.",
    'Usually no prebuilt binary matched your Node version/platform and no C/C++ compiler was found.',
    '',
    'Try one of:',
    '  • Use a current Node LTS (20 or 22): https://nodejs.org',
    '  • Install build tools so it can compile from source, then `npm rebuild better-sqlite3`:',
    '      Windows — the "Desktop development with C++" workload (Visual Studio Build Tools)',
    '      Debian/Ubuntu/Raspberry Pi — sudo apt-get install -y build-essential python3',
    '      macOS — xcode-select --install',
    '  • On Windows, the Modulus desktop app ships its own runtime and avoids this entirely.',
  ].join('\n');
}
