import { readFile } from 'node:fs/promises';

export class RoutingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
    this.details = details;
  }
}

export function requireValue(condition, code, message, details) {
  if (!condition) throw new RoutingError(code, message, details);
}

export function validateRatings(snapshot, { now = Date.now(), maxAgeHours = 168, allowSynthetic = false } = {}) {
  requireValue(snapshot?.source === 'artificial-analysis', 'INVALID_RATINGS', 'Expected an Artificial Analysis snapshot.');
  requireValue(!snapshot.synthetic || allowSynthetic, 'SYNTHETIC_RATINGS', 'Synthetic demo/test ratings cannot authorize model calls.');
  const fetched = Date.parse(snapshot.fetchedAt);
  requireValue(Number.isFinite(fetched) && fetched <= now + 300_000 && now - fetched <= maxAgeHours * 3_600_000,
    'STALE_RATINGS', 'Refresh the rating snapshot before routing.');
  requireValue(/^\d+(\.\d+)*$/.test(String(snapshot.indexVersion)), 'INVALID_INDEX_VERSION', 'An index version is required.');
  requireValue(Array.isArray(snapshot.models), 'INVALID_RATINGS', 'Snapshot models must be an array.');
  const rows = new Map();
  for (const row of snapshot.models) {
    requireValue(typeof row.slug === 'string' && row.slug.length > 0 && !rows.has(row.slug), 'INVALID_RATINGS', 'Missing or duplicate AA slug.');
    requireValue(row.intelligenceIndex === null || (typeof row.intelligenceIndex === 'number'
      && Number.isFinite(row.intelligenceIndex) && row.intelligenceIndex >= 0), 'INVALID_RATINGS', 'Invalid Intelligence Index.');
    rows.set(row.slug, row);
  }
  return rows;
}

// Bindings are explicit model + reasoning-variant matches. No name similarity or
// interpolated scores: a model tested at high says nothing about its low score.
export function ratingFor(bindings, rows, host, model, effort) {
  const matches = bindings.filter(b => b.host === host && b.model === model && b.effort === effort);
  requireValue(matches.length === 1, 'UNRATED_VARIANT', `No unique verified rating binding for ${host}/${model}/${effort}.`);
  const binding = matches[0];
  requireValue(typeof binding.evidenceUrl === 'string'
    && /^https:\/\/artificialanalysis\.ai\//.test(binding.evidenceUrl), 'INVALID_BINDING', 'Binding requires an AA evidence URL.');
  const row = rows.get(binding.aaSlug);
  requireValue(row && row.intelligenceIndex !== null, 'UNRATED_VARIANT', `No measured Intelligence Index for ${binding.aaSlug}.`);
  return { intelligenceIndex: row.intelligenceIndex, aaSlug: row.slug, evidenceUrl: binding.evidenceUrl };
}

export async function readJSON(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function fetchRatings({ apiKey = process.env.AA_API_KEY, fetchImpl = fetch, now = Date.now() } = {}) {
  requireValue(typeof apiKey === 'string' && apiKey.length > 0, 'MISSING_AA_KEY', 'Set AA_API_KEY to refresh leaderboard metadata.');
  const models = [];
  let version;
  for (let page = 1; page <= 100; page++) {
    const response = await fetchImpl(`https://artificialanalysis.ai/api/v2/language/models/free?page=${page}`, {
      headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(20_000)
    });
    requireValue(response.ok, 'AA_HTTP_ERROR', `Artificial Analysis returned HTTP ${response.status}.`);
    const body = await response.json();
    requireValue(Array.isArray(body.data) && body.intelligence_index_version != null, 'AA_SCHEMA_ERROR', 'Unrecognized AA response.');
    const pageVersion = String(body.intelligence_index_version);
    requireValue(version === undefined || version === pageVersion, 'MIXED_INDEX_VERSIONS', 'Index changed during pagination; refresh again.');
    version = pageVersion;
    for (const row of body.data) models.push({
      slug: row.slug, name: row.name,
      intelligenceIndex: row.evaluations?.artificial_analysis_intelligence_index ?? null
    });
    requireValue(typeof body.pagination?.has_more === 'boolean', 'AA_SCHEMA_ERROR', 'Pagination metadata is required.');
    if (!body.pagination.has_more) {
      const snapshot = {
        source: 'artificial-analysis', sourceUrl: 'https://artificialanalysis.ai/data-api/docs',
        attribution: 'Intelligence Index data: Artificial Analysis (https://artificialanalysis.ai/)',
        indexVersion: version, fetchedAt: new Date(now).toISOString(), models
      };
      validateRatings(snapshot, { now });
      return snapshot;
    }
  }
  throw new RoutingError('AA_PAGINATION_LIMIT', 'Leaderboard pagination exceeded its limit.');
}
