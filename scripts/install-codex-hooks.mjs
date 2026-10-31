import { readFile } from 'node:fs/promises';
import { installCodexHooks } from '../lib/install-hooks.mjs';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
console.log(JSON.stringify(await installCodexHooks({ version }), null, 2));
