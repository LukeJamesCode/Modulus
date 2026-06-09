#!/usr/bin/env node
// Modulus CLI entrypoint. Phase 1 wired only `modulus start`; Phase 3 fills in
// the rest of the subcommands (see docs/cli-reference.md).

// Tint all stdout/stderr green when running in a TTY. Side-effect import,
// must run before anything else writes.
import './color.js';

// Register tsx so the compiled CLI can dynamically import .ts extension files.
import { register } from 'tsx/esm/api';
register();

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';

// Subcommands are pulled in lazily. Keeping the top of the CLI free of heavy
// transitive imports (grammY, better-sqlite3, the LLM client) means `modulus
// --help` and quick subcommands like `modulus status` boot in tens of ms
// instead of paying the full daemon's import cost.

function fail(prefix: string, e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`${prefix}: ${msg}\n`);
  process.exit(1);
}

async function call<T extends unknown[]>(
  name: string,
  fn: (...args: T) => Promise<void>,
  ...args: T
): Promise<void> {
  try {
    await fn(...args);
  } catch (e) {
    // @inquirer/prompts throws this when the user hits Ctrl-C — don't print
    // a scary stack for an intentional cancel.
    if (e instanceof Error && (e.name === 'ExitPromptError' || e.name === 'AbortError')) {
      process.stderr.write('\n(cancelled)\n');
      process.exit(130);
    }
    fail(`modulus ${name} failed`, e);
  }
}

const program = new Command();
program
  .name('modulus')
  .description('Small, terminal-first AI agent. CPU-only. Extensions turn it into anything.')
  .version('0.0.0');

program
  .command('start')
  .description('Run the bot (Telegram long-poll + Ollama) and the web panel if enabled')
  .option('--detach', 'Run as a background process; write a pid file')
  .option('--agent-only', 'Do not also start the modulus-frontend web panel')
  .action(async (opts: { detach?: boolean; agentOnly?: boolean }) => {
    const { run } = await import('./start.js');
    await call('start', run, { detach: !!opts.detach, agentOnly: !!opts.agentOnly });
  });

program
  .command('init')
  .description('First-run wizard: telegram token, allowlist, ollama, models')
  .action(async () => {
    const { run } = await import('./init.js');
    await call('init', run);
  });

program
  .command('config')
  .description('Interactive settings TUI (core + extensions)')
  .action(async () => {
    const { run } = await import('./config.js');
    await call('config', run);
  });

program
  .command('auth')
  .argument('<extension>', 'Extension name to authorize')
  .description('Run an extension auth flow')
  .action(async (extension: string) => {
    const { run } = await import('./auth.js');
    await call('auth', run, extension);
  });

program
  .command('models')
  .description('Pick chat / reasoning model profiles from Ollama')
  .action(async () => {
    const { run } = await import('./models.js');
    await call('models', run);
  });

program
  .command('stop')
  .description('Stop a running modulus daemon and the web panel')
  .option('--agent-only', 'Do not also stop the modulus-frontend web panel')
  .action(async (opts: { agentOnly?: boolean }) => {
    const { run } = await import('./stop.js');
    await call('stop', run, { agentOnly: !!opts.agentOnly });
  });

program
  .command('logs')
  .option('-f, --follow', 'Follow new log lines, like `tail -f`')
  .option('--panel', "Stream the panel process's log (where Tudor course builds run)")
  .description('Stream the modulus log file')
  .action(async (opts: { follow?: boolean; panel?: boolean }) => {
    const { run } = await import('./logs.js');
    await call('logs', run, { follow: !!opts.follow, panel: !!opts.panel });
  });

program
  .command('status')
  .option('--json', 'Emit a single JSON object instead of two-column text')
  .description('One-shot summary of bot health (config, ollama, extensions)')
  .action(async (opts: { json?: boolean }) => {
    const { run } = await import('./status.js');
    await call('status', run, { json: !!opts.json });
  });

program
  .command('doctor')
  .description('Run preflight diagnostics (config, telegram, ollama, ram, extensions)')
  .action(async () => {
    const { run } = await import('./doctor.js');
    await call('doctor', run);
  });

// Internal: the panel runner. Hidden because the user-facing surface is
// `modulus start` (which spawns it) and `modulus stop` (which kills it) —
// see panel.ts.
program
  .command('__panel', { hidden: true })
  .description('(internal) Run the modulus-frontend panel server in this process')
  .action(async () => {
    const { run } = await import('./frontend.js');
    await call('__panel', run);
  });

program
  .command('update')
  .description('Pull latest code, reinstall dependencies, and rebuild')
  .action(async () => {
    const { run } = await import('./update.js');
    await call('update', run);
  });

program
  .command('fresh')
  .description('Wipe all Modulus data, update code, and re-run the setup wizard')
  .option('-y, --yes', 'Skip the destructive confirmation prompt')
  .option('--skip-init', 'Wipe and update without launching the terminal setup wizard')
  .option('--keep-panel', 'Do not stop the modulus-frontend panel process')
  .action(async (opts: { yes?: boolean; skipInit?: boolean; keepPanel?: boolean }) => {
    const { run } = await import('./fresh.js');
    await call('fresh', run, {
      yes: !!opts.yes,
      init: !opts.skipInit,
      stopPanel: !opts.keepPanel,
    });
  });

program
  .command('abilitytest')
  .description('Run scripted ability tests against a fresh in-process Modulus (no Telegram)')
  .option('--tier <tier>', 'smoke | standard | full', 'standard')
  .option('--filter <regex>', 'only run tests whose id or ability matches this regex')
  .option('--out <path>', 'where to write the markdown report')
  .option(
    '--fails',
    're-run only the tests that failed or errored in the most recent ~/.modulus/ability-test-*.md report (forces --tier full so filter spans every tier)',
  )
  .action(async (opts: { tier?: string; filter?: string; out?: string; fails?: boolean }) => {
    // The runner lives in the modulus-abilitytest extension (so it can ship,
    // be hot-reloaded, and own its catalog). The CLI is a thin shim that
    // resolves the .ts file by absolute path and dynamically imports it —
    // tsx handles the on-the-fly transpile.
    const here = dirname(fileURLToPath(import.meta.url));
    const runnerPath = resolve(here, '..', '..', 'extensions', 'modulus-abilitytest', 'runner.ts');
    const mod = (await import(pathToFileURL(runnerPath).href)) as {
      run: (opts: {
        tier: 'smoke' | 'standard' | 'full';
        filter?: string;
        outFile?: string;
      }) => Promise<void>;
    };

    let tier = (opts.tier ?? 'standard') as 'smoke' | 'standard' | 'full';
    if (tier !== 'smoke' && tier !== 'standard' && tier !== 'full') {
      throw new Error(`Unknown tier '${tier}'. Use smoke | standard | full.`);
    }

    let filter = opts.filter;

    if (opts.fails) {
      if (opts.filter !== undefined) {
        throw new Error('--fails and --filter are mutually exclusive.');
      }
      // Derived filter from the latest saved report. We force tier=full because
      // failed tests can come from any tier in the previous run, and a narrower
      // tier would silently drop some of the rows we mean to re-run.
      const cfg = await import('./config-store.js');
      const home = cfg.homeDir();
      const fs = await import('node:fs');
      const path = await import('node:path');
      let reports: string[];
      try {
        reports = fs
          .readdirSync(home)
          .filter((f) => f.startsWith('ability-test-') && f.endsWith('.md'))
          .sort();
      } catch (e) {
        throw new Error(
          `Cannot read ${home}: ${e instanceof Error ? e.message : String(e)}. Run 'modulus abilitytest' once before --fails.`,
        );
      }
      if (reports.length === 0) {
        throw new Error(
          `No prior ability-test report in ${home}. Run 'modulus abilitytest' first to generate one.`,
        );
      }
      const latest = reports.at(-1)!;
      const md = fs.readFileSync(path.join(home, latest), 'utf8');
      // Parse table rows. judgeTest writes either `✗ fail` or `! error` into
      // the first column; renderMarkdown wraps the id in backticks.
      const ids: string[] = [];
      for (const line of md.split('\n')) {
        const m = /^\|\s+[✗!]\s+(?:fail|error)\s+\|\s+`([^`]+)`/.exec(line);
        if (m) ids.push(m[1]!);
      }
      if (ids.length === 0) {
        process.stdout.write(`No failed/errored tests in ${latest} — nothing to re-run.\n`);
        return;
      }
      const escaped = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      filter = `^(${escaped.join('|')})$`;
      tier = 'full';
      process.stdout.write(
        `re-running ${ids.length} failed test(s) from ${latest}:\n  ${ids.join('\n  ')}\n\n`,
      );
    }

    await call('abilitytest', mod.run, {
      tier,
      ...(filter !== undefined ? { filter } : {}),
      ...(opts.out !== undefined ? { outFile: opts.out } : {}),
    });
  });

const extCmd = program.command('ext').description('Manage extensions');
extCmd
  .command('list')
  .description('List installed extensions and their state')
  .action(async () => {
    const ext = await import('./ext.js');
    await call('ext list', ext.list);
  });
extCmd
  .command('install')
  .argument('<source>', 'Local path, git URL, or repo extension name')
  .description('Install an extension')
  .action(async (source: string) => {
    const ext = await import('./ext.js');
    await call('ext install', ext.install, source);
  });
extCmd
  .command('enable')
  .argument('<name>')
  .description('Enable an installed extension')
  .action(async (name: string) => {
    const ext = await import('./ext.js');
    await call('ext enable', ext.enable, name);
  });
extCmd
  .command('disable')
  .argument('<name>')
  .description('Disable an installed extension')
  .action(async (name: string) => {
    const ext = await import('./ext.js');
    await call('ext disable', ext.disable, name);
  });
extCmd
  .command('uninstall')
  .argument('<name>')
  .option('--purge', 'Also drop the extension settings and state')
  .description('Uninstall an extension installed under ~/.modulus/extensions/')
  .action(async (name: string, opts: { purge?: boolean }) => {
    const ext = await import('./ext.js');
    await call('ext uninstall', ext.uninstall, name, { purge: !!opts.purge });
  });
extCmd
  .command('reload')
  .argument('[name]')
  .description('Touch extension folders so a running modulus hot-reloads them')
  .action(async (name: string | undefined) => {
    const ext = await import('./ext.js');
    await call('ext reload', ext.reload, name);
  });
extCmd
  .command('create')
  .argument('<name>', 'Extension name (e.g. modulus-todo)')
  .argument('[dir]', 'Parent directory (default: current working directory)')
  .description('Scaffold a runnable starter extension you can edit and publish')
  .action(async (name: string, dir: string | undefined) => {
    const ext = await import('./ext.js');
    await call('ext create', ext.create, name, dir);
  });

program.parseAsync(process.argv).catch((e) => {
  fail('modulus', e);
});
