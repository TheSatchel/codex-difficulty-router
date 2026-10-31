import path from 'node:path';
import os from 'node:os';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readJSON, requireValue } from './ratings.mjs';
import { validateConfig, normalizeCodexCatalog } from './route.mjs';
import { ratingsCache } from './ratings-cache.mjs';
import { matchAvailableModels } from './model-match.mjs';

export function configPath() {
  if (process.env.CDR_CONFIG) {
    requireValue(path.isAbsolute(process.env.CDR_CONFIG), 'MISSING_CONFIG', 'CDR_CONFIG must be an absolute path.');
    return process.env.CDR_CONFIG;
  }
  return path.join(dataDirectory(), 'routing.json');
}

export async function loadContext(file = configPath(), options = {}) {
  const config = validateConfig(await readJSON(file));
  const resolve = name => path.resolve(path.dirname(file), name);
  let snapshot;
  if (config.ratingsMode === 'leaderboard' || config.ratingSources?.length || !config.ratingsPath) {
    const cached = await configuredCache(config, options);
    requireValue(cached.usable, 'RATINGS_CACHE_UNAVAILABLE', 'Neither a live webpage refresh nor a valid cached rating is available.', cached.lastAttempt);
    snapshot = cached.snapshot;
  } else {
    requireValue(typeof config.ratingsPath === 'string', 'MISSING_RATINGS', 'Configure public ratingSources or a private ratings snapshot path.');
    snapshot = await readJSON(resolve(config.ratingsPath));
  }
  const catalog = config.catalogPath ? await readJSON(resolve(config.catalogPath)) : [];
  return applyCatalog({ config, snapshot, catalog, configFile: file }, catalog);
}

export async function configuredCache(config = {}, options = {}) {
  return ratingsCache({ directory: path.join(dataDirectory(), 'ratings-cache'),
    urls: config.ratingSources, maxAgeHours: config.maxRatingAgeHours ?? 168,
    refreshIntervalSeconds: config.refreshIntervalSeconds ?? 300, ...options });
}

export function backendCommand() {
  return process.env.CDR_CODEX_COMMAND ? JSON.parse(process.env.CDR_CODEX_COMMAND) : [codexBinary(), 'app-server', 'proxy'];
}

export function codexBinary({ platform = process.platform, exists = existsSync } = {}) {
  if (platform === 'darwin') {
    const installed = [
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/Applications/Codex.app/Contents/Resources/codex'
    ].find(exists);
    if (installed) return installed;
  }
  return 'codex';
}

export function dataDirectory() {
  return process.env.CDR_DATA_DIR ?? process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA ?? path.join(os.homedir(), '.local', 'state', 'codex-difficulty-router');
}

export async function saveJSON(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

export async function withCatalog(context, rpc) {
  return applyCatalog(context, normalizeCodexCatalog(await rpc.models()));
}

export function applyCatalog(context, catalog) {
  const matched = matchAvailableModels(context.snapshot, catalog, context.config.bindings);
  return { ...context, catalog, config: { ...context.config, bindings: matched.bindings }, coverage: matched.coverage };
}
