// `modulus config` — interactive settings TUI.
//
// Two layers:
//   1. Core settings (`telegram.*`, `ollama.url`, `models.*`, `tier`, `logLevel`)
//      stored in ~/.modulus/config.json.
//   2. Per-extension settings declared via the extension's settings.schema.json,
//      stored in the `module_settings` SQLite table.
//
// The TUI presents both in one menu organised by section so the user can move
// between core and any installed extension without re-launching.

import { confirm, input, password, select } from '@inquirer/prompts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extensionFolders } from './extension-paths.js';
import { open as openDb } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import {
  effectiveConfig,
  homeDir,
  loadConfig,
  parseAllowedIds,
  saveConfig,
  type ModulusConfig,
} from './config-store.js';

interface SchemaProperty {
  type: 'string' | 'number' | 'boolean';
  default?: string | number | boolean;
  description?: string;
  secret?: boolean;
}

interface SettingsSchema {
  type: 'object';
  properties: Record<string, SchemaProperty>;
  required?: string[];
}

interface ExtensionEntry {
  name: string;
  schema: SettingsSchema | undefined;
}

function discoverExtensionsForSettings(home: string): ExtensionEntry[] {
  const seen = new Set<string>();
  const out: ExtensionEntry[] = [];
  for (const { folder } of extensionFolders(home)) {
    try {
      const manifest = join(folder, 'manifest.json');
      if (!existsSync(manifest)) continue;
      const m = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (!m.name || seen.has(m.name)) continue;
      seen.add(m.name);
      const schemaPath = join(folder, 'settings.schema.json');
      const schema = existsSync(schemaPath)
        ? (JSON.parse(readFileSync(schemaPath, 'utf8')) as SettingsSchema)
        : undefined;
      out.push({ name: m.name, schema });
    } catch {
      // Skip malformed extension folders silently — `modulus doctor` covers
      // diagnostics. The config TUI shouldn't blow up because one folder
      // has bad JSON.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function run(): Promise<void> {
  const home = homeDir();
  const exts = discoverExtensionsForSettings(home);

  for (;;) {
    const sectionChoices = [
      { name: 'core (telegram / ollama / models / tier)', value: '__core__' },
      ...exts.map((e) => ({ name: e.name, value: e.name })),
      { name: '(quit)', value: '__quit__' },
    ];
    const pick = await select({ message: 'Choose section:', choices: sectionChoices });
    if (pick === '__quit__') return;
    if (pick === '__core__') {
      await editCore(home);
    } else {
      const ext = exts.find((e) => e.name === pick);
      if (!ext) continue;
      await editExtension(home, ext);
    }
  }
}

async function editCore(home: string): Promise<void> {
  const cfg = loadConfig(home);
  const effective = effectiveConfig(home);
  for (;;) {
    const choices = [
      { name: `telegram.token: ${cfg.telegram.token ? '(set)' : '(unset)'}`, value: 'token' },
      {
        name: `telegram.allowedIds: ${cfg.telegram.allowedIds.join(',') || '(none)'}`,
        value: 'allowed',
      },
      { name: `ollama.url: ${cfg.ollama.url}`, value: 'ollamaUrl' },
      {
        name: `models.chat: ${cfg.models.chat}`,
        value: 'chat',
      },
      {
        name: `models.reason: ${cfg.models.reason ?? '(unset)'}`,
        value: 'reason',
      },
      {
        name: `models.tools: ${cfg.models.tools ?? '(unset)'}`,
        value: 'tools',
      },
      { name: `tier: ${cfg.tier ?? '(auto)'}`, value: 'tier' },
      { name: `logLevel: ${cfg.logLevel ?? 'info'}`, value: 'logLevel' },
      { name: '(back)', value: '__back__' },
    ];
    const pick = await select({ message: 'Edit core setting:', choices });
    if (pick === '__back__') return;
    if (pick === 'token') {
      cfg.telegram.token = (await password({ message: 'Telegram bot token:', mask: '*' })).trim();
    } else if (pick === 'allowed') {
      const raw = await input({
        message: 'Allowed Telegram user IDs (comma-separated):',
        default: cfg.telegram.allowedIds.join(','),
        validate: (v) => {
          try {
            parseAllowedIds(v);
            return true;
          } catch (e) {
            return (e as Error).message;
          }
        },
      });
      cfg.telegram.allowedIds = parseAllowedIds(raw);
    } else if (pick === 'ollamaUrl') {
      cfg.ollama.url = (await input({ message: 'Ollama URL:', default: cfg.ollama.url })).trim();
    } else if (pick === 'chat') {
      cfg.models.chat = (
        await input({ message: 'Chat model tag:', default: cfg.models.chat })
      ).trim();
    } else if (pick === 'reason') {
      const v = (
        await input({
          message: 'Reasoning model (blank to clear):',
          default: cfg.models.reason ?? '',
        })
      ).trim();
      if (v) {
        cfg.models.reason = v;
      } else {
        delete cfg.models.reason;
      }
    } else if (pick === 'tools') {
      const v = (
        await input({
          message: 'Tool-use model (blank to clear; chat model handles tools when unset):',
          default: cfg.models.tools ?? '',
        })
      ).trim();
      if (v) {
        cfg.models.tools = v;
      } else {
        delete cfg.models.tools;
      }
    } else if (pick === 'tier') {
      cfg.tier = (await select({
        message: 'Hardware tier:',
        choices: [
          { name: 'small', value: 'small' },
          { name: 'standard', value: 'standard' },
          { name: 'heavy', value: 'heavy' },
        ],
        default: cfg.tier ?? 'standard',
      })) as ModulusConfig['tier'];
    } else if (pick === 'logLevel') {
      cfg.logLevel = (await select({
        message: 'Log level:',
        choices: ['debug', 'info', 'warn', 'error'].map((v) => ({ name: v, value: v })),
        default: cfg.logLevel ?? 'info',
      })) as ModulusConfig['logLevel'];
    }
    saveConfig(cfg, home);
    if (effectiveDiffers(cfg, effective)) {
      process.stdout.write('Note: an environment variable is overriding this value at runtime.\n');
    }
  }
}

function effectiveDiffers(file: ModulusConfig, effective: ModulusConfig): boolean {
  return (
    file.telegram.token !== effective.telegram.token ||
    file.ollama.url !== effective.ollama.url ||
    file.models.chat !== effective.models.chat ||
    file.models.reason !== effective.models.reason ||
    file.models.tools !== effective.models.tools
  );
}

async function editExtension(home: string, ext: ExtensionEntry): Promise<void> {
  if (!ext.schema) {
    process.stdout.write(`(${ext.name} has no settings schema.)\n`);
    return;
  }
  const log = createLogger({ level: 'warn' });
  const db = openDb({ path: join(home, 'modulus.db'), log });
  try {
    for (;;) {
      const current = readSettings(db, ext.name, ext.schema);
      const choices = Object.entries(ext.schema.properties).map(([k, decl]) => {
        const v = current[k];
        const display = decl.secret
          ? v === undefined
            ? '(unset)'
            : '(set)'
          : String(v ?? '(unset)');
        return {
          name: `${k}: ${display}${decl.description ? ` — ${decl.description}` : ''}`,
          value: k,
        };
      });
      choices.push({ name: '(back)', value: '__back__' });
      const pick = await select({ message: `${ext.name} settings:`, choices });
      if (pick === '__back__') return;
      const decl = ext.schema.properties[pick]!;
      const newValue = await promptForSchemaValue(pick, decl, current[pick]);
      if (newValue === undefined) {
        deleteSetting(db, ext.name, pick);
      } else {
        writeSetting(db, ext.name, pick, newValue);
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

async function promptForSchemaValue(
  key: string,
  decl: SchemaProperty,
  current: string | number | boolean | undefined,
): Promise<string | number | boolean | undefined> {
  if (decl.type === 'boolean') {
    return await confirm({
      message: `${key}:`,
      default: typeof current === 'boolean' ? current : decl.default === true,
    });
  }
  if (decl.type === 'number') {
    const raw = await input({
      message: `${key} (number${decl.description ? ` — ${decl.description}` : ''}, blank to clear):`,
      default:
        current !== undefined
          ? String(current)
          : decl.default !== undefined
            ? String(decl.default)
            : '',
      validate: (v) => v.trim() === '' || Number.isFinite(Number(v)) || 'Must be numeric.',
    });
    if (raw.trim() === '') return undefined;
    return Number(raw);
  }
  // string
  const raw = decl.secret
    ? await password({
        message: `${key}${decl.description ? ` — ${decl.description}` : ''} (blank to clear):`,
        mask: '*',
      })
    : await input({
        message: `${key}${decl.description ? ` — ${decl.description}` : ''} (blank to clear):`,
        default:
          current !== undefined
            ? String(current)
            : decl.default !== undefined
              ? String(decl.default)
              : '',
      });
  if (raw.trim() === '') return undefined;
  return raw;
}

function readSettings(
  db: ReturnType<typeof openDb>,
  ext: string,
  schema: SettingsSchema,
): Record<string, string | number | boolean | undefined> {
  const rows = db
    .prepare(`SELECT key, value FROM module_settings WHERE module = ?`)
    .all(ext) as Array<{ key: string; value: string }>;
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const [k, decl] of Object.entries(schema.properties)) {
    if (decl.default !== undefined) out[k] = decl.default;
  }
  for (const r of rows) {
    const decl = schema.properties[r.key];
    if (!decl) continue;
    if (decl.type === 'number') out[r.key] = Number(r.value);
    else if (decl.type === 'boolean') out[r.key] = r.value === 'true';
    else out[r.key] = r.value;
  }
  return out;
}

function writeSetting(
  db: ReturnType<typeof openDb>,
  ext: string,
  key: string,
  value: string | number | boolean,
): void {
  db.prepare(
    `INSERT INTO module_settings (module, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(module, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(ext, key, String(value), Date.now());
}

function deleteSetting(db: ReturnType<typeof openDb>, ext: string, key: string): void {
  db.prepare(`DELETE FROM module_settings WHERE module = ? AND key = ?`).run(ext, key);
}
