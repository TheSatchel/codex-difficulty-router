import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublicModels } from '../lib/leaderboard.mjs';
import { assessRating, routingSnapshot } from '../lib/rating-assessment.mjs';
import { modelRecord, leaderboardFixture } from '../fixtures/leaderboard.mjs';

const now = Date.parse('2026-11-01T00:00:00Z');
const records = [modelRecord('example-max', 'Example (Max)', 42),
  modelRecord('example-high', 'Example (High)', null),
  modelRecord('estimated', 'Estimated (Max)', 45, { intelligenceIndexIsEstimated: true })];
const snapshot = () => normalizePublicModels(records, { now, indexVersion: '5.0' });

test('a measured exact model and effort yields its score and evidence', () => {
  const r = assessRating(snapshot(), { model: 'example', effort: 'max', now });
  assert.equal(r.status, 'verified'); assert.equal(r.intelligenceIndex, 42);
  assert.equal(r.evidenceUrl, 'https://artificialanalysis.ai/models/example-max');
  assert.equal(r.indexVersion, '5.0'); assert.equal(r.observedAt, new Date(now).toISOString());
});

test('strict mode preserves exact-only admission and ambiguous variants stay blocked', () => {
  assert.equal(assessRating(snapshot(), { model: 'example', effort: 'high', now, allowEstimates: false }).status, 'unrated');
  assert.equal(assessRating(snapshot(), { model: 'example', effort: 'ultra', now, allowEstimates: false }).status, 'not-in-leaderboard');
  assert.equal(assessRating(snapshot(), { model: 'estimated', effort: 'max', now }).verified, false);
  const duplicate = normalizePublicModels([...records, modelRecord('duplicate-max', 'Example (Max)', 43)], { now, indexVersion: '5.0' });
  assert.equal(assessRating(duplicate, { model: 'example', effort: 'max', now }).status, 'ambiguous');
  assert.throws(() => assessRating(snapshot(), { model: 'example', now }), { code: 'EXACT_MODE_REQUIRED' });
});

test('offline assessment reads the bundled input without network calls', async () => {
  let calls = 0;
  const r = await routingSnapshot({ snapshot: snapshot(), offline: true, now,
    fetchImpl: async () => { calls++; throw Error('Unexpected network'); } });
  assert.equal(calls, 0); assert.equal(r.source, 'bundled-cache'); assert.equal(r.usable, true);
});

test('online failure falls back to a valid snapshot without making it look newer', async () => {
  const s = snapshot(); const before = JSON.stringify(s);
  const r = await routingSnapshot({ snapshot: s, now: now + 1000, fetchImpl: async () => { throw Error('offline'); } });
  assert.equal(r.usable, true); assert.equal(r.refresh.status, 'failed');
  assert.equal(JSON.stringify(r.snapshot), before);
});

test('expired or synthetic snapshots cannot authorize an assessment', async () => {
  const expired = await routingSnapshot({ snapshot: snapshot(), now: now + 169 * 3600000, offline: true });
  assert.equal(expired.usable, false); assert.equal(expired.error.code, 'STALE_RATINGS');
  const synthetic = await routingSnapshot({ snapshot: { ...snapshot(), synthetic: true }, now, offline: true });
  assert.equal(synthetic.usable, false); assert.equal(synthetic.error.code, 'SYNTHETIC_RATINGS');
});

test('online refresh replaces an expired snapshot with the complete public result', async () => {
  const f = leaderboardFixture(records);
  const r = await routingSnapshot({ snapshot: snapshot(), now: now + 169 * 3600000, fetchImpl: f.fetchImpl });
  assert.equal(r.usable, true); assert.equal(r.source, 'public-web');
  assert.equal(r.snapshot.models.length, records.length);
  assert.equal(assessRating(r.snapshot, { model: 'example', effort: 'max', now: now + 169 * 3600000 }).verified, true);
});
