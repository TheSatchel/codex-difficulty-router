import { readJSON, validateRatings, ratingFor, requireValue } from './ratings.mjs';
import { fetchLeaderboard } from './leaderboard.mjs';
import { matchAvailableModels } from './model-match.mjs';

// Reading ratings never invokes a model, discovers a host or writes a cache.
export async function routingSnapshot({ offline = false, snapshot, now = Date.now(),
  fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  let refresh = { attempted: false, status: 'disabled' };
  if (!offline) {
    try {
      const updated = await fetchLeaderboard({ fetchImpl, now, timeoutMs });
      validateRatings(updated, { now });
      return { usable: true, source: 'public-web', snapshot: updated,
        refresh: { attempted: true, status: 'updated' } };
    } catch (error) {
      refresh = { attempted: true, status: 'failed', code: error.code ?? 'NETWORK_ERROR', message: error.message };
    }
  }
  try {
    const bundled = snapshot ?? await readJSON(new URL('../data/leaderboard.json', import.meta.url));
    validateRatings(bundled, { now });
    return { usable: true, source: 'bundled-cache', snapshot: bundled, refresh };
  } catch (error) {
    return { usable: false, source: 'unavailable', refresh,
      error: { code: error.code ?? 'CACHE_READ_ERROR', message: error.message } };
  }
}

export function assessRating(snapshot, { model, effort, now = Date.now() } = {}) {
  requireValue(typeof model === 'string' && model.trim() && typeof effort === 'string' && effort.trim(),
    'EXACT_MODE_REQUIRED', 'Supply the actual host model ID and reasoning effort.');
  const rows = validateRatings(snapshot, { now });
  const match = matchAvailableModels(snapshot, [{ host: 'codex', model, efforts: [effort] }]);
  const variant = match.coverage.variants[0];
  const row = snapshot.models.find(r => r.slug === variant.aaSlug);
  const verified = variant.status === 'matched';
  const rating = verified ? ratingFor(match.bindings, rows, 'codex', model, effort) : null;
  return { model, effort, status: verified ? 'verified' : variant.status, verified,
    intelligenceIndex: rating?.intelligenceIndex ?? null,
    aaSlug: variant.aaSlug ?? null, evidenceUrl: rating?.evidenceUrl ?? row?.evidenceUrl ?? null,
    indexVersion: snapshot.indexVersion, observedAt: row?.observedAt ?? snapshot.fetchedAt };
}
