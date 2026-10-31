import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { readJSON, validateRatings, requireValue } from './ratings.mjs';
import { checkedModelURL, fetchWebRatings } from './web-ratings.mjs';
import { fetchLeaderboard, LEADERBOARD_URL } from './leaderboard.mjs';

const pending = new Map();
async function optionalJSON(file) {
  try { return await readJSON(file); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
}

export async function ratingsCache({ directory, urls, now = Date.now(),
  maxAgeHours = 168, refreshIntervalSeconds = 300, timeoutMs, force = false, cacheOnly = false, fetchImpl = fetch } = {}) {
  requireValue(typeof directory === 'string' && directory.length > 0 && Number.isFinite(maxAgeHours) && maxAgeHours > 0
    && Number.isFinite(refreshIntervalSeconds) && refreshIntervalSeconds >= 0, 'INVALID_CACHE_CONFIG', 'Invalid rating cache settings.');
  const fullLeaderboard = urls === undefined || urls.length === 0;
  const sources = fullLeaderboard ? [LEADERBOARD_URL] : [...new Set(urls.map(value => checkedModelURL(value).href))].sort();
  const key = createHash('sha256').update(JSON.stringify(sources)).digest('hex').slice(0, 20);
  const file = path.join(directory, `${key}.json`), statusFile = path.join(directory, `${key}.status.json`);
  if (!cacheOnly && pending.has(file)) return pending.get(file);
  const job = (async () => {
    let snapshot = await optionalJSON(file);
    let valid = false;
    try { validateRatings(snapshot, { now, maxAgeHours }); valid = true; } catch { /* Do not authorize an invalid/stale cache. */ }
    const status = await optionalJSON(statusFile);
    if (cacheOnly) return { snapshot, usable: valid, status: valid ? 'cached' : 'unavailable', file, lastAttempt: status };
    if (!force && status && now - Date.parse(status.attemptedAt) < refreshIntervalSeconds * 1000) {
      return { snapshot, usable: valid, status: valid ? 'cached' : 'unavailable', file, lastAttempt: status };
    }
    await save(statusFile, { attemptedAt: new Date(now).toISOString(), result: 'refreshing' });
    try {
      const updated = fullLeaderboard ? await fetchLeaderboard({ fetchImpl, now, timeoutMs })
        : await fetchWebRatings({ urls: sources, fetchImpl, now, timeoutMs });
      if (!fullLeaderboard && valid && String(snapshot.indexVersion) === String(updated.indexVersion)) {
        const merged = new Map(snapshot.models.map(row => [row.slug, { ...row, observedAt: row.observedAt ?? snapshot.fetchedAt }]));
        for (const row of updated.models) merged.set(row.slug, row);
        updated.models = [...merged.values()].filter(row => now - Date.parse(row.observedAt) <= maxAgeHours * 3_600_000);
        // An online refresh must not make an older retained record look fresh.
        updated.fetchedAt = new Date(Math.min(...updated.models.map(row => Date.parse(row.observedAt)))).toISOString();
        validateRatings(updated, { now, maxAgeHours });
      }
      await save(file, updated);
      const status = updated.failures.length ? 'partial-update' : 'updated';
      const lastAttempt = { attemptedAt: new Date(now).toISOString(), result: status, failures: updated.failures };
      await save(statusFile, lastAttempt);
      return { snapshot: updated, usable: true, status, file, lastAttempt };
    } catch (error) {
      const lastAttempt = { attemptedAt: new Date(now).toISOString(), result: 'failed', code: error.code ?? 'NETWORK_ERROR', message: error.message };
      await save(statusFile, lastAttempt);
      return { snapshot, usable: valid, status: valid ? 'offline-cache' : 'unavailable', file, lastAttempt };
    }
  })();
  if (cacheOnly) return job;
  pending.set(file, job);
  try { return await job; } finally { pending.delete(file); }
}

export function cacheSummary(result) {
  return { status: result.status, usable: result.usable, file: result.file,
    fetchedAt: result.snapshot?.fetchedAt, indexVersion: result.snapshot?.indexVersion,
    modelCount: result.snapshot?.models?.length ?? 0, lastAttempt: result.lastAttempt,
    coverage: result.snapshot?.coverage,
    attribution: 'Intelligence Index: Artificial Analysis — https://artificialanalysis.ai/' };
}
