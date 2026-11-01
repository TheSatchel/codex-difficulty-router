#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readJSON, requireValue } from '../lib/ratings.mjs';
import { ratingsCache, cacheSummary } from '../lib/ratings-cache.mjs';
import { matchAvailableModels } from '../lib/model-match.mjs';
import { routingSnapshot, assessRating } from '../lib/rating-assessment.mjs';
import { routeTask } from '../lib/task-routing.mjs';
import { readCurrentMode } from '../lib/session-mode.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, 'cache-dir': { type: 'string' },
    catalog: { type: 'string' }, force: { type: 'boolean', default: false },
    model: { type: 'string' }, effort: { type: 'string' }, offline: { type: 'boolean', default: false },
    request: { type: 'string' }, strict: { type: 'boolean', default: false },
    current: { type: 'boolean', default: false }
  } });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') {
    process.stdout.write('Read-only context, ratings and route decisions; no App control or model calls.\n\n  context\n  route --request FILE [--current] [--offline] [--strict]\n  assess --model EXACT_ID --effort EFFORT [--catalog FILE] [--offline] [--strict]\n  cache --cache-dir DIR [--force]\n  coverage --cache-dir DIR --catalog FILE\n\nContext reads only the active CODEX_THREAD_ID session metadata. Route resolves it automatically when parent is omitted; --current always uses it. Same-model estimates are labelled; --strict requires exact measurements. Nothing runs at plugin startup.\n');
  } else if (command === 'context') {
    const context = await readCurrentMode();
    console.log(JSON.stringify(context, null, 2));
    if (context.status !== 'resolved') process.exitCode = 2;
  } else if (command === 'route') {
    requireValue(values.request?.trim(), 'ROUTE_REQUEST_REQUIRED', 'Supply an explicit routing request file.');
    const request = await readJSON(path.resolve(values.request));
    const context = values.current || !request.parent ? await readCurrentMode() : null;
    if (context?.status === 'resolved') request.parent = context.mode;
    if (values.strict) request.allowEstimates = false;
    const policy = await readJSON(new URL('../data/routing-policy.json', import.meta.url));
    const loaded = context && context.status !== 'resolved' ? { usable: false, source: 'unavailable', error: { code: context.reason } }
      : await routingSnapshot({ offline: values.offline });
    const report = context && context.status !== 'resolved'
      ? { status: 'blocked', reason: 'current-mode-unavailable', context, modelCalls: 0, selection: null }
      : loaded.usable ? routeTask(loaded.snapshot, request, policy)
      : { status: 'blocked', reason: 'ratings-unavailable', modelCalls: 0, selection: null, error: loaded.error };
    console.log(JSON.stringify({ ...report, ...(context?.status === 'resolved' ? { modeSource: context.provenance } : {}), source: loaded.source, refresh: loaded.refresh }, null, 2));
    if (report.status === 'blocked') process.exitCode = 2;
  } else if (command === 'assess') {
    requireValue(values.model?.trim() && values.effort?.trim(), 'EXACT_MODE_REQUIRED', 'Supply the actual host model ID and reasoning effort.');
    const loaded = await routingSnapshot({ offline: values.offline });
    const report = { modelCalls: 0, source: loaded.source, usable: loaded.usable, refresh: loaded.refresh };
    if (loaded.usable) {
      report.rating = assessRating(loaded.snapshot, { model: values.model, effort: values.effort, allowEstimates: !values.strict });
      report.fetchedAt = loaded.snapshot.fetchedAt;
      report.modelCount = loaded.snapshot.models.length;
      if (values.catalog) {
        const catalog = await readJSON(path.resolve(values.catalog));
        requireValue(Array.isArray(catalog) && catalog.every(m => typeof m.model === 'string' && Array.isArray(m.efforts)),
          'INVALID_CATALOG', 'The actual host catalog must be an array with model IDs and efforts.');
        report.variants = catalog.flatMap(m => m.efforts.map(effort => assessRating(loaded.snapshot, { model: m.model, effort, allowEstimates: !values.strict })));
      }
      if (!report.rating.usableForRouting) process.exitCode = 2;
    } else {
      report.error = loaded.error;
      process.exitCode = 2;
    }
    console.log(JSON.stringify(report, null, 2));
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
