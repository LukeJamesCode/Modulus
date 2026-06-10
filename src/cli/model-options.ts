import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extensionFolders } from './extension-paths.js';
import { open as openDb, type DB } from '../storage/db.js';
import { createLogger } from '../util/log.js';
import { homeDir } from './config-store.js';

export const CODEX_MODEL_ALIAS = 'codex';
const CODEX_EXTENSION = 'modulus-codex';

export function isCodexModelRef(model: string | undefined): boolean {
  return model === CODEX_MODEL_ALIAS || !!model?.startsWith(`${CODEX_MODEL_ALIAS}:`);
}

export function isExternalModelRef(model: string | undefined): boolean {
  return isCodexModelRef(model);
}

export function availableModelTags(
  ollamaModels: readonly string[],
  home: string = homeDir(),
): string[] {
  const out = [...ollamaModels];
  if (codexExtensionEnabled(home)) out.push(CODEX_MODEL_ALIAS);
  return [...new Set(out)];
}

function codexExtensionInstalled(home: string): boolean {
  for (const { folder } of extensionFolders(home)) {
    try {
      const raw = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as {
        name?: string;
      };
      if (raw.name === CODEX_EXTENSION) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function withDb<T>(home: string, fn: (db: DB) => T): T | undefined {
  if (!existsSync(join(home, 'modulus.db'))) return undefined;
  const db = openDb({ path: join(home, 'modulus.db'), log: createLogger({ level: 'warn' }) });
  try {
    return fn(db);
  } catch {
    return undefined;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

export function codexExtensionEnabled(home: string = homeDir()): boolean {
  if (!codexExtensionInstalled(home)) return false;
  return (
    withDb(home, (db) => {
      const row = db
        .prepare(`SELECT enabled FROM module_state WHERE name = ?`)
        .get(CODEX_EXTENSION) as { enabled: number } | undefined;
      return row?.enabled !== 0;
    }) ?? false
  );
}
