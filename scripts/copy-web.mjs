// Copy the panel's browser assets from src/panel/web to dist/panel/web. tsc
// only emits compiled .ts; the panel's static server resolves its UI (.jsx /
// .js / .html / .css) relative to the compiled server.js via import.meta.url,
// so without this step dist/panel/web is missing and every asset 404s in a
// built (non-tsx) deployment.

import { cpSync, mkdirSync } from 'node:fs';

const SRC = 'src/panel/web';
const DST = 'dist/panel/web';

mkdirSync(DST, { recursive: true });
cpSync(SRC, DST, { recursive: true });
console.log(`copied panel web assets to ${DST}`);
