import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../storage/db.js';
import type { Manifest, SettingsSchema } from './modules.js';

export type ModuleReadinessStatus = 'ready' | 'needs_auth' | 'needs_settings' | 'disabled';

export interface ModuleReadiness {
  name: string;
  version: string;
  folder: string;
  source: 'user' | 'repo';
  enabled: boolean;
  status: ModuleReadinessStatus;
  reasons: string[];
  nextAction?: string;
}

interface InstalledModule {
  name: string;
  version: string;
  folder: string;
  source: 'user' | 'repo';
  manifest: Manifest;
  schema?: SettingsSchema;
}

export function collectModuleReadiness(roots: readonly string[], db: DB): ModuleReadiness[] {
  const installed = discoverInstalledModules(roots);
  const enabledByName = readEnabledMap(db);
  const settingsByExt = readSettingsMap(db);

  return installed.map((ext) => {
    const enabled = enabledByName.get(ext.name) ?? true;
    if (!enabled) {
      return {
        name: ext.name,
        version: ext.version,
        folder: ext.folder,
        source: ext.source,
        enabled: false,
        status: 'disabled',
        reasons: ['disabled in module_state'],
        nextAction: `modulus ext enable ${ext.name}`,
      };
    }

    const settings = settingsByExt.get(ext.name) ?? new Map<string, string>();
    const missingAuth = missingAuthSettings(ext, settings);
    if (missingAuth.length > 0) {
      return {
        name: ext.name,
        version: ext.version,
        folder: ext.folder,
        source: ext.source,
        enabled: true,
        status: 'needs_auth',
        reasons: missingAuth.map((k) => `missing auth setting: ${k}`),
        nextAction: `modulus auth ${ext.name}`,
      };
    }

    const missingRequired = missingRequiredSettings(ext, settings);
    if (missingRequired.length > 0) {
      return {
        name: ext.name,
        version: ext.version,
        folder: ext.folder,
        source: ext.source,
        enabled: true,
        status: 'needs_settings',
        reasons: missingRequired.map((k) => `missing required setting: ${k}`),
        nextAction: 'modulus config',
      };
    }

    return {
      name: ext.name,
      version: ext.version,
      folder: ext.folder,
      source: ext.source,
      enabled: true,
      status: 'ready',
      reasons: [],
    };
  });
}

export function formatModuleReadinessLine(ext: ModuleReadiness): string {
  const reason = ext.reasons.length > 0 ? ` — ${ext.reasons.join('; ')}` : '';
  const action = ext.nextAction ? ` — next: ${ext.nextAction}` : '';
  return `${ext.name}@${ext.version}  [${ext.status}]  (${ext.source}) ${ext.folder}${reason}${action}`;
}

export function formatModuleReadinessForTelegram(
  modules: readonly Pick<
    ModuleReadiness,
    'name' | 'status' | 'reasons' | 'nextAction' | 'enabled'
  >[],
): string {
  if (modules.length === 0) return 'No modules installed yet.';
  return modules
    .map((ext) => {
      const reason = ext.reasons.length > 0 ? ` — ${ext.reasons.join('; ')}` : '';
      const action = ext.nextAction ? `\n  next: ${ext.nextAction}` : '';
      return `• ${ext.name} — ${ext.status}${reason}${action}`;
    })
    .join('\n');
}

export function setupIssuesForNudge(modules: readonly ModuleReadiness[]): ModuleReadiness[] {
  return modules.filter((ext) => ext.enabled && ext.status !== 'ready');
}

export function formatSetupIssuesNudge(issues: readonly ModuleReadiness[]): string {
  if (issues.length === 0) return '';
  const lines = [
    `Modulus has ${issues.length} module setup issue${issues.length === 1 ? '' : 's'}:`,
  ];
  for (const ext of issues.slice(0, 8)) {
    const reason = ext.reasons[0] ? ` — ${ext.reasons[0]}` : '';
    const action = ext.nextAction ? ` Next: ${ext.nextAction}` : '';
    lines.push(`• ${ext.name}: ${ext.status}${reason}.${action}`);
  }
  if (issues.length > 8) lines.push(`• …and ${issues.length - 8} more.`);
  lines.push('Use /modules for the current list.');
  return lines.join('\n');
}

function discoverInstalledModules(roots: readonly string[]): InstalledModule[] {
  const out: InstalledModule[] = [];
  const seen = new Set<string>();
  roots.forEach((root, index) => {
    const source: 'user' | 'repo' = index === 0 ? 'user' : 'repo';
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return;
    }
    for (const entry of entries) {
      const folder = join(root, entry);
      try {
        if (!statSync(folder).isDirectory()) continue;
        const manifestPath = join(folder, 'manifest.json');
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
        if (!manifest.name || !manifest.version || seen.has(manifest.name)) continue;
        seen.add(manifest.name);
        const schemaPath = join(folder, 'settings.schema.json');
        const schema = existsSync(schemaPath)
          ? (JSON.parse(readFileSync(schemaPath, 'utf8')) as SettingsSchema)
          : undefined;
        out.push({
          name: manifest.name,
          version: manifest.version,
          folder,
          source,
          manifest,
          ...(schema ? { schema } : {}),
        });
      } catch {
        continue;
      }
    }
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readEnabledMap(db: DB): Map<string, boolean> {
  const rows = db.prepare(`SELECT name, enabled FROM module_state`).all() as Array<{
    name: string;
    enabled: number;
  }>;
  return new Map(rows.map((r) => [r.name, r.enabled !== 0]));
}

function readSettingsMap(db: DB): Map<string, Map<string, string>> {
  const rows = db.prepare(`SELECT module, key, value FROM module_settings`).all() as Array<{
    module: string;
    key: string;
    value: string;
  }>;
  const out = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const settings = out.get(row.module) ?? new Map<string, string>();
    settings.set(row.key, row.value);
    out.set(row.module, settings);
  }
  return out;
}

function missingRequiredSettings(
  ext: Pick<InstalledModule, 'schema'>,
  settings: ReadonlyMap<string, string>,
): string[] {
  const schema = ext.schema;
  if (!schema) return [];
  return (schema.required ?? []).filter((key) => {
    const decl = schema.properties[key];
    if (!decl) return false;
    if (decl.default !== undefined) return false;
    return !hasSetting(settings, key);
  });
}

function missingAuthSettings(
  ext: Pick<InstalledModule, 'manifest' | 'schema'>,
  settings: ReadonlyMap<string, string>,
): string[] {
  if (!ext.manifest.entrypoints?.auth || !ext.schema) return [];
  const requiredAuth = missingRequiredSettings(ext, settings).filter((key) =>
    isAuthSettingKey(key, ext.schema!.properties[key]?.secret === true),
  );
  const optionalAuthTokens = Object.entries(ext.schema.properties)
    .filter(([key, decl]) => decl.default === undefined && isTokenLikeAuthKey(key))
    .filter(([key]) => !hasSetting(settings, key))
    .map(([key]) => key);
  return [...new Set([...requiredAuth, ...optionalAuthTokens])];
}

function hasSetting(settings: ReadonlyMap<string, string>, key: string): boolean {
  const value = settings.get(key);
  return value !== undefined && value.trim().length > 0;
}

function isAuthSettingKey(key: string, secret: boolean): boolean {
  return (
    secret || /(^|_)(client_id|client_secret|api_key|token|secret|credential)s?(_|$)/i.test(key)
  );
}

function isTokenLikeAuthKey(key: string): boolean {
  return /(^|_)(refresh_token|access_token|token|credential)s?(_|$)/i.test(key);
}
