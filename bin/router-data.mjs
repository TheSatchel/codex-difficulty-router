#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readJSON, requireValue } from '../lib/ratings.mjs';
import { ratingsCache, cacheSummary } from '../lib/ratings-cache.mjs';
import { matchAvailableModels } from '../lib/model-match.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, 'cache-dir': { type: 'string' },
    catalog: { type: 'string' }, force: { type: 'boolean', default: false }
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') {
    process.stdout.write('Public ratings data only; no App control or model calls.\n\n  cache --cache-dir DIR [--force]\n  coverage --cache-dir DIR --catalog FILE\n\nAn explicit cache directory is required. Nothing runs automatically.\n');
  } else {
    requireValue(['cache', 'coverage'].includes(command), 'UNKNOWN_COMMAND', 'Only cache and coverage data commands are supported.');
    requireValue(values['cache-dir']?.trim(), 'EXPLICIT_CACHE_REQUIRED', 'Specify --cache-dir explicitly; there is no default global data directory.');
    if (command === 'coverage') requireValue(values.catalog, 'EXPLICIT_CATALOG_REQUIRED', 'Supply an actual host catalog with --catalog. No host is started or probed.');
    const cached = await ratingsCache({ directory: path.resolve(values['cache-dir']),
      force: values.force, cacheOnly: command === 'coverage' });
    const report = { modelCalls: 0, ...cacheSummary(cached) };
    if (command === 'coverage' && cached.usable) {
      const catalog = await readJSON(path.resolve(values.catalog));
      requireValue(Array.isArray(catalog), 'INVALID_CATALOG', 'The host catalog must be an array.');
      report.host = matchAvailableModels(cached.snapshot, catalog).coverage;
    }
    console.log(JSON.stringify(report, null, 2));
    if (!cached.usable) process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? 'DATA_ERROR', message: error.message }));
  process.exitCode = 1;
}
