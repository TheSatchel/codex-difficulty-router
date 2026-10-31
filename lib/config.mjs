import path from 'node:path';
import os from 'node:os';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readJSON, requireValue } from './ratings.mjs';
import { validateConfig, normalizeCodexCatalog } from './route.mjs';

export function configPath() {
  requireValue(process.env.CDR_CONFIG && path.isAbsolute(process.env.CDR_CONFIG), 'MISSING_CONFIG', 'Set CDR_CONFIG to an absolute, user-owned routing config path.');
  return process.env.CDR_CONFIG;
}

export async function loadContext(file = configPath()) {
  const config = validateConfig(await readJSON(file));
  const resolve = name => path.resolve(path.dirname(file), name);
  requireValue(typeof config.ratingsPath === 'string', 'MISSING_RATINGS', 'Configure a ratings snapshot path.');
  const snapshot = await readJSON(resolve(config.ratingsPath));
  const catalog = config.catalogPath ? await readJSON(resolve(config.catalogPath)) : [];
  return { config, snapshot, catalog, configFile: file };
}

export function backendCommand() {
  return process.env.CDR_CODEX_COMMAND ? JSON.parse(process.env.CDR_CODEX_COMMAND) : ['codex', 'app-server', 'proxy'];
}

export function dataDirectory() {
  return process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA ?? path.join(os.homedir(), '.local', 'state', 'codex-difficulty-router');
}

export async function saveJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

export async function withCatalog(context, rpc) {
  return { ...context, catalog: normalizeCodexCatalog(await rpc.models()) };
}
