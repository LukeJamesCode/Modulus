// Copy SQL migration files from src/storage/migrations to dist/storage/migrations.
// tsc only compiles .ts; SQL files are runtime assets that travel alongside
// the compiled db.js so its import.meta.url-based resolution finds them.

import { mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'src/storage/migrations';
const DST = 'dist/storage/migrations';

mkdirSync(DST, { recursive: true });

let count = 0;
for (const file of readdirSync(SRC)) {
  if (!file.endsWith('.sql')) continue;
  copyFileSync(join(SRC, file), join(DST, file));
  count++;
}
console.log(`copied ${count} migration file(s) to ${DST}`);
