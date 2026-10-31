import { createHash } from 'node:crypto';
import { requireValue, validateRatings } from './ratings.mjs';

export const DEFAULT_WEB_SOURCES = [
  'https://artificialanalysis.ai/models/gpt-6-1-sol',
  'https://artificialanalysis.ai/models/gpt-6-astra',
  'https://artificialanalysis.ai/models/gpt-6-sol',
  'https://artificialanalysis.ai/models/gpt-6-luna'
];

export function checkedModelURL(value) {
  const url = new URL(value);
  requireValue(url.origin === 'https://artificialanalysis.ai' && /^\/models\/[a-z0-9-]+\/?$/.test(url.pathname)
    && !url.search && !url.hash && !url.username && !url.password,
  'INVALID_RATINGS_URL', 'Use an official Artificial Analysis model detail URL.');
  return url;
}

export function parseModelPage(html, sourceUrl) {
  const url = checkedModelURL(sourceUrl);
  requireValue(typeof html === 'string' && html.length <= 8 * 1024 * 1024, 'INVALID_WEB_PAGE', 'Model page is missing or too large.');
  const text = value => value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|#160);/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const titleHTML = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  requireValue(titleHTML, 'WEB_SCHEMA_CHANGED', 'Model page has no recognizable heading.');
  const title = text(titleHTML), plain = text(html);
  const effort = title.match(/\((none|minimal|low|medium|high|xhigh|max|ultra)\)/i)?.[1]?.toLowerCase();
  requireValue(effort, 'UNVERIFIED_WEB_VARIANT', 'The page does not identify an exact reasoning effort.');
  const summary = plain.match(/Model summary\s+([\s\S]*?)(?=Comparison Summary|Technical specifications)/i)?.[1];
  const score = summary?.match(/\b(N\/A|\d+(?:\.\d+)?)\s+Artificial Analysis Intelligence Index\b/i)?.[1];
  const indexVersion = plain.match(/Artificial Analysis Intelligence Index\s+v(\d+(?:\.\d+)*)/i)?.[1];
  requireValue(score !== undefined && indexVersion, 'WEB_SCHEMA_CHANGED', 'The published score or index version could not be verified.');
  return { indexVersion, model: {
    slug: url.pathname.split('/').filter(Boolean).at(-1), name: title.split(' Intelligence,')[0],
    evaluatedEffort: effort, intelligenceIndex: score.toUpperCase() === 'N/A' ? null : Number(score),
    evidenceUrl: url.href, pageSha256: createHash('sha256').update(html).digest('hex')
  } };
}

export async function fetchWebRatings({ urls = DEFAULT_WEB_SOURCES, fetchImpl = fetch, now = Date.now(), timeoutMs = 4000 } = {}) {
  requireValue(Array.isArray(urls) && urls.length > 0 && urls.length <= 20, 'INVALID_RATINGS_URL', 'Configure 1–20 exact model pages.');
  const canonical = [...new Set(urls.map(value => checkedModelURL(value).href))];
  const pages = [], failures = [];
  for (let start = 0; start < canonical.length; start += 4) {
    const batchURLs = canonical.slice(start, start + 4);
    const batch = await Promise.allSettled(batchURLs.map(async url => {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      requireValue(response.ok, 'AA_WEB_HTTP_ERROR', `Artificial Analysis returned HTTP ${response.status}.`);
      if (response.url) checkedModelURL(response.url);
      return parseModelPage(await response.text(), url);
    }));
    batch.forEach((result, i) => {
      if (result.status === 'fulfilled') pages.push(result.value);
      else failures.push({ url: batchURLs[i], code: result.reason.code ?? 'NETWORK_ERROR', message: result.reason.message });
    });
  }
  requireValue(pages.length > 0, 'AA_WEB_UNAVAILABLE', 'No model page could be verified; preserve the previous cache.', { failures });
  requireValue(new Set(pages.map(p => p.indexVersion)).size === 1, 'MIXED_INDEX_VERSIONS', 'Web pages use different index versions; keep the previous cache.');
  const snapshot = { source: 'artificial-analysis', retrieval: 'public-web', sourceUrls: canonical,
    attribution: 'Intelligence Index data: Artificial Analysis (https://artificialanalysis.ai/)',
    indexVersion: pages[0].indexVersion, fetchedAt: new Date(now).toISOString(),
    failures, models: pages.map(p => ({ ...p.model, observedAt: new Date(now).toISOString() })) };
  validateRatings(snapshot, { now });
  return snapshot;
}
