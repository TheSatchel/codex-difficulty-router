import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseModelPage } from '../lib/web-ratings.mjs';
import { leaderboardFixture, modelRecord } from '../fixtures/leaderboard.mjs';
import { ratingsCache } from '../lib/ratings-cache.mjs';
import { ratingFor } from '../lib/ratings.mjs';

// Fictional page structure/values for parser behavior, not leaderboard data.
const page = (score = '42', version = '5.0', effort = 'Max') => `<h1>Example (${effort}) Intelligence, Performance &amp; Price Analysis</h1>
  <div>Model summary Intelligence Updated # 7 / 58 ${score} Artificial Analysis Intelligence Index
  Comparison Summary Example description. Artificial Analysis Intelligence Index v${version} incorporates evaluations.</div>`;
const url = 'https://artificialanalysis.ai/models/example';
const response = () => ({ ok: true, url, text: async () => page() });
async function directory(t) { const folder = await mkdtemp(path.join(tmpdir(), 'cdr-cache-')); t.after(() => rm(folder, { force: true, recursive: true })); return folder; }

test('webpage parser records exact effort, score, version and provenance without an API', () => {
  const parsed = parseModelPage(page(), url);
  assert.equal(parsed.model.intelligenceIndex, 42); assert.equal(parsed.model.evaluatedEffort, 'max');
  assert.equal(parsed.indexVersion, '5.0'); assert.equal(parsed.model.pageSha256.length, 64);
});

test('webpage N/A stays missing and an unidentified effort is not inferred', () => {
  assert.equal(parseModelPage(page('N/A'), url).model.intelligenceIndex, null);
  assert.throws(() => parseModelPage(page('42', '5.0', 'unknown'), url), { code: 'UNVERIFIED_WEB_VARIANT' });
  assert.throws(() => parseModelPage('<h1>New layout</h1>', url));
  assert.throws(() => parseModelPage(page(), 'https://example.com/models/example'), { code: 'INVALID_RATINGS_URL' });
});

test('published Max score cannot authorize an Ultra binding', () => {
  const row = parseModelPage(page(), url).model;
  assert.throws(() => ratingFor([{ host: 'codex', model: 'example', effort: 'ultra', aaSlug: row.slug, evidenceUrl: url }],
    new Map([[row.slug, row]]), 'codex', 'example', 'ultra'), { code: 'UNRATED_VARIANT' });
});

test('online refresh saves cache; warm-cache requests use the refresh interval', async t => {
  const folder = await directory(t); let calls = 0;
  const args = { directory: folder, urls: [url], fetchImpl: async () => { calls++; return response(); } };
  const fresh = await ratingsCache(args);
  assert.equal(fresh.status, 'updated'); assert.equal(fresh.usable, true);
  const second = await ratingsCache(args);
  assert.equal(second.status, 'cached'); assert.equal(calls, 1);
  assert.equal(JSON.parse(await readFile(fresh.file, 'utf8')).retrieval, 'public-web');
});

test('offline refresh retains the last valid cache without changing its observation date', async t => {
  const folder = await directory(t), now = Date.now();
  const first = await ratingsCache({ directory: folder, urls: [url], now, fetchImpl: async () => response() });
  const before = await readFile(first.file, 'utf8');
  const offline = await ratingsCache({ directory: folder, urls: [url], now: now + 1000, force: true,
    fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(offline.status, 'offline-cache'); assert.equal(offline.usable, true);
  assert.equal(await readFile(first.file, 'utf8'), before);
});

test('expired cache plus network failure never authorizes routing', async t => {
  const folder = await directory(t), now = Date.now();
  await ratingsCache({ directory: folder, urls: [url], now, fetchImpl: async () => response() });
  const result = await ratingsCache({ directory: folder, urls: [url], now: now + 169 * 3_600_000,
    fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(result.usable, false); assert.equal(result.status, 'unavailable');
});

test('synchronous cache-only reads neither contact the network nor create cache directories', async t => {
  const folder = await directory(t); let requests = 0;
  const result = await ratingsCache({ directory: path.join(folder, 'missing'), cacheOnly: true,
    fetchImpl: async () => { requests++; throw new Error('Network must not run from synchronous hooks.'); } });
  assert.equal(requests, 0); assert.equal(result.usable, false);
});

test('a valid local cache read does not wait for an in-flight online refresh', async t => {
  const folder = await directory(t);
  await ratingsCache({ directory: folder, urls: [url], fetchImpl: async () => response() });
  let release, began;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  const refreshing = ratingsCache({ directory: folder, urls: [url], force: true,
    fetchImpl: async () => { began(); await held; return response(); } });
  await started;
  let deadline;
  try {
    const local = await Promise.race([ratingsCache({ directory: folder, urls: [url], cacheOnly: true }),
      new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('A local cache read waited for network')), 1000); })]);
    assert.equal(local.usable, true);
  } finally { clearTimeout(deadline); release(); await refreshing; }
});

test('a malformed online page does not overwrite the good cache', async t => {
  const folder = await directory(t);
  const first = await ratingsCache({ directory: folder, urls: [url], fetchImpl: async () => response() });
  const before = await readFile(first.file, 'utf8');
  const result = await ratingsCache({ directory: folder, urls: [url], force: true,
    fetchImpl: async () => ({ ok: true, text: async () => '<h1>Changed</h1>' }) });
  assert.equal(result.status, 'offline-cache'); assert.equal(await readFile(first.file, 'utf8'), before);
});

test('coincident refreshes coalesce into a single fetch', async t => {
  const folder = await directory(t); let calls = 0;
  const args = { directory: folder, urls: [url], force: true, fetchImpl: async () => { calls++; return response(); } };
  const results = await Promise.all([ratingsCache(args), ratingsCache(args), ratingsCache(args)]);
  assert.ok(results.every(x => x.usable)); assert.equal(calls, 1);
});

test('partial network success refreshes good rows while preserving older rows and their dates', async t => {
  const folder = await directory(t), now = Date.now();
  const other = 'https://artificialanalysis.ai/models/other', urls = [url, other];
  const first = await ratingsCache({ directory: folder, urls, now,
    fetchImpl: async source => ({ ok: true, url: source, text: async () => page() }) });
  const second = await ratingsCache({ directory: folder, urls, now: now + 1000, force: true,
    fetchImpl: async source => { if (source === other) throw new Error('offline for one page'); return response(); } });
  assert.equal(second.status, 'partial-update'); assert.equal(second.snapshot.models.length, 2);
  assert.equal(second.snapshot.models.find(row => row.slug === 'other').observedAt, first.snapshot.fetchedAt);
  assert.equal(second.snapshot.models.find(row => row.slug === 'example').observedAt, new Date(now + 1000).toISOString());
  assert.equal(second.snapshot.fetchedAt, first.snapshot.fetchedAt);
});
