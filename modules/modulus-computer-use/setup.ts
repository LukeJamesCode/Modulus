// Setup entrypoint for modulus-computer-use. The screen-capture and input
// backend is pure PowerShell/.NET, so there is nothing heavy to install — no
// npm native deps, no toolchain (the whole point on a box without a C++
// compiler). There is therefore no ensureNpmDeps step; this just reminds the
// user that PowerShell must be on PATH (built in on Windows 10/11) and that the
// app allowlist has to be set before the operator can act.

import type { ModuleSetupContext } from '../../src/core/modules.js';

export async function setup(ctx: ModuleSetupContext): Promise<void> {
  ctx.stdout('  ✓ modulus-computer-use uses built-in PowerShell/.NET — nothing to download.\n');
  ctx.stdout(
    '  Before it can act, open Settings → modulus-computer-use and set "Allowed apps"\n' +
      '  (e.g. notepad,chrome). It refuses to operate any window that is not allowlisted.\n',
  );
}
