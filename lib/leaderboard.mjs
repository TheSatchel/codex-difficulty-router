import { requireValue } from './ratings.mjs';
import { createDecipheriv, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { validateRatings } from './ratings.mjs';
import { variantFromName } from './model-match.mjs';

export const LEADERBOARD_URL = 'https://artificialanalysis.ai/leaderboards/models';

// Read JSON values from public server-rendered page data. Never execute page JS.
function jsonEnd(text, start) {
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '[' || c === '{') depth++;
    else if ((c === ']' || c === '}') && --depth === 0) return i + 1;
  }
  return -1;
}

export function publicModelRecords(html) {
  requireValue(typeof html === 'string' && html.length <= 32 * 1024 * 1024, 'INVALID_WEB_PAGE', 'Leaderboard page is missing or too large.');
  const fragments = [];
  const marker = 'self.__next_f.push(';
  let cursor = 0;
  while ((cursor = html.indexOf(marker, cursor)) !== -1) {
    const start = html.indexOf('[', cursor + marker.length), end = jsonEnd(html, start);
    requireValue(start >= 0 && end > start, 'WEB_SCHEMA_CHANGED', 'Unrecognized public page data frame.');
    const frame = JSON.parse(html.slice(start, end));
    if (frame[0] === 1 && typeof frame[1] === 'string') fragments.push(frame[1]);
    cursor = end;
  }
  const payloads = [fragments.join(''), html];
  for (const payload of payloads) {
    const match = /"initialModels"\s*:\s*(\[)/.exec(payload);
    if (!match) continue;
    const start = match.index + match[0].lastIndexOf('['), end = jsonEnd(payload, start);
    requireValue(end > start, 'WEB_SCHEMA_CHANGED', 'Incomplete public model array.');
    const records = JSON.parse(payload.slice(start, end));
    requireValue(Array.isArray(records) && records.length > 0 && records.length <= 20_000
      && records.every(row => row && typeof row.slug === 'string' && typeof row.name === 'string'
        && Object.hasOwn(row, 'intelligenceIndex')), 'WEB_SCHEMA_CHANGED', 'Unrecognized public model record schema.');
    const manifestMatch = /"manifest"\s*:\s*(\{)/.exec(payload);
    let manifest = null;
    if (manifestMatch) {
      const manifestStart = manifestMatch.index + manifestMatch[0].lastIndexOf('{');
      const manifestEnd = jsonEnd(payload, manifestStart);
      if (manifestEnd > manifestStart) manifest = JSON.parse(payload.slice(manifestStart, manifestEnd));
    }
    return { records, manifest, payload: fragments.join('') };
  }
  throw Object.assign(new Error('The complete public model array was not found; keep the previous full cache.'), { code: 'WEB_SCHEMA_CHANGED' });
}

export function decodePublicData(bytes, key) {
  if (!key) return JSON.parse(Buffer.from(bytes).toString('utf8'));
  requireValue(typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key), 'WEB_SCHEMA_CHANGED', 'Invalid public page data descriptor.');
  const material = Buffer.from(key, 'hex'), data = Buffer.from(bytes);
  requireValue(data.length > 16 && data.length <= 32 * 1024 * 1024, 'INVALID_WEB_PAGE', 'Invalid public data package size.');
  // The unauthenticated page publishes this descriptor for its All-models
  // selector. Mirror that public loader without executing downloaded scripts.
  const iv = createHash('sha256').update(material).digest().subarray(0, 12);
  const decipher = createDecipheriv('aes-256-gcm', material, iv);
  decipher.setAuthTag(data.subarray(-16));
  const compressed = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
  return JSON.parse(gunzipSync(compressed, { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8'));
}

const measured = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function normalizePublicModels(records, { indexVersion, now = Date.now(), dataUrl = null } = {}) {
  requireValue(Array.isArray(records) && records.length > 0 && records.length <= 20_000, 'WEB_SCHEMA_CHANGED', 'Expected the complete model list.');
  const observedAt = new Date(now).toISOString();
  const models = records.map(raw => {
    requireValue(raw && typeof raw.slug === 'string' && typeof raw.name === 'string'
      && Object.hasOwn(raw, 'intelligenceIndex'), 'WEB_SCHEMA_CHANGED', 'Unrecognized public model row.');
    return { slug: raw.slug, name: raw.name, ...variantFromName(raw.name, raw.isReasoning),
      intelligenceIndex: measured(raw.intelligenceIndex), estimated: raw.intelligenceIndexIsEstimated === true,
      deprecated: raw.deprecated === true, creator: raw.modelCreatorName ?? null,
      contextWindowTokens: measured(raw.contextWindowTokens), observedAt,
      evidenceUrl: `https://artificialanalysis.ai/models/${encodeURIComponent(raw.slug)}`,
      publicMetrics: { unit: 'USD', speedTier: 'unspecified',
        inputPerMillion: measured(raw.price1mInputTokens), outputPerMillion: measured(raw.price1mOutputTokens),
        cacheHitPerMillion: measured(raw.cacheHitPrice), cacheWritePerMillion: measured(raw.cacheWritePrice),
        intelligenceIndexCostPerTask: measured(raw.intelligenceIndexCostPerTask),
        outputTokensPerSecond: measured(raw.medianOutputTokensPerSecond),
        ttftSeconds: measured(raw.medianTimeToFirstTokenSeconds),
        endToEndSeconds: measured(raw.medianEndToEndResponseTimeSeconds) },
      raw };
  });
  const snapshot = { source: 'artificial-analysis', retrieval: 'public-leaderboard-data',
    sourceUrls: [LEADERBOARD_URL], dataUrl, fetchedAt: observedAt, indexVersion,
    attribution: 'Intelligence Index data: Artificial Analysis (https://artificialanalysis.ai/)', failures: [], models,
    coverage: { scope: 'all-published-models-and-variants', total: models.length,
      scored: models.filter(m => m.intelligenceIndex !== null).length,
      measured: models.filter(m => m.intelligenceIndex !== null && !m.estimated).length,
      estimated: models.filter(m => m.intelligenceIndex !== null && m.estimated).length,
      unscored: models.filter(m => m.intelligenceIndex === null).length,
      deprecated: models.filter(m => m.deprecated).length,
      creators: new Set(models.map(m => m.creator).filter(Boolean)).size,
      withTokenPrices: models.filter(m => m.publicMetrics.inputPerMillion !== null && m.publicMetrics.outputPerMillion !== null).length,
      withSpeed: models.filter(m => m.publicMetrics.outputTokensPerSecond !== null).length } };
  validateRatings(snapshot, { now });
  return snapshot;
}

export async function fetchLeaderboard({ fetchImpl = fetch, now = Date.now(), timeoutMs = 15000 } = {}) {
  const options = () => ({ signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  const page = await fetchImpl(LEADERBOARD_URL, options());
  requireValue(page.ok, 'AA_WEB_HTTP_ERROR', `Leaderboard returned HTTP ${page.status}.`);
  const html = await page.text(), { records: current, manifest, payload } = publicModelRecords(html);
  const indexVersion = (payload + html).match(/Artificial Analysis Intelligence Index\s+v(\d+(?:\.\d+)*)/i)?.[1];
  requireValue(indexVersion && manifest?.path, 'WEB_SCHEMA_CHANGED', 'Complete-list descriptor or index version is missing.');
  const url = new URL(manifest.path, LEADERBOARD_URL);
  requireValue(url.origin === 'https://artificialanalysis.ai' && /^\/data\/[a-zA-Z0-9._/-]+\.(txt|json)$/.test(url.pathname)
    && !url.search && !url.hash, 'INVALID_RATINGS_URL', 'Unexpected public data package destination.');
  const response = await fetchImpl(url.href, options());
  requireValue(response.ok, 'AA_WEB_HTTP_ERROR', `Public model data returned HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer()), decoded = decodePublicData(bytes, manifest.key);
  const all = Array.isArray(decoded) ? decoded : decoded.models;
  requireValue(Array.isArray(all) && all.length >= current.length, 'INCOMPLETE_LEADERBOARD', 'All-model data is smaller than the visible current list.');
  const slugs = new Set(all.map(row => row.slug));
  requireValue(current.every(row => slugs.has(row.slug)), 'INCOMPLETE_LEADERBOARD', 'All-model data omitted a visible current model.');
  const snapshot = normalizePublicModels(all, { indexVersion, now, dataUrl: url.href });
  snapshot.coverage.currentPageRows = current.length;
  snapshot.dataSha256 = createHash('sha256').update(bytes).digest('hex');
  return snapshot;
}
