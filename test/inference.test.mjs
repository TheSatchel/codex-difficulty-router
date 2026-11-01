import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublicModels } from '../lib/leaderboard.mjs';
import { modelRecord } from '../fixtures/leaderboard.mjs';
import { assessRating } from '../lib/rating-assessment.mjs';
import { routeTask } from '../lib/task-routing.mjs';
import { readJSON } from '../lib/ratings.mjs';

const now = Date.parse('2026-11-01T10:00:00Z');
const policy = await readJSON(new URL('../data/routing-policy.json', import.meta.url));
const make = records => normalizePublicModels(records, { now, indexVersion: '5.0' });
const records = [modelRecord('low', 'Example (Low)', 10), modelRecord('high', 'Example (High)', 30), modelRecord('max', 'Example (Max)', 40)];

test('Ultra can use a same-model Max reference without fabricating an Ultra measurement or bonus', () => {
  const r = assessRating(make(records), { model: 'example', effort: 'ultra', now });
  assert.equal(r.status, 'estimated'); assert.equal(r.verified, false); assert.equal(r.usableForRouting, true);
  assert.equal(r.intelligenceIndex, 40); assert.equal(r.aaSlug, null); assert.equal(r.evidenceUrl, null);
  assert.equal(r.inference.method, 'nearest-effort-proxy'); assert.equal(r.inference.anchors[0].effort, 'max');
  assert.equal(r.inference.anchors[0].evidenceUrl, 'https://artificialanalysis.ai/models/max');
});
test('missing interior effort is interpolated only between measured same-model anchors', () => {
  const r = assessRating(make(records), { model: 'example', effort: 'medium', now });
  assert.equal(r.intelligenceIndex, 20); assert.equal(r.inference.method, 'same-model-interpolation');
  assert.deepEqual(r.inference.anchors.map(x => x.effort), ['low', 'high']);
  const exact = assessRating(make([...records, modelRecord('medium', 'Example (Medium)', 18)]), { model: 'example', effort: 'medium', now });
  assert.equal(exact.intelligenceIndex, 18); assert.equal(exact.estimated, false); assert.equal(exact.verified, true);
});
test('a published model-level score is a labelled proxy when effort is unspecified', () => {
  const r = assessRating(make([modelRecord('base', 'Example', 25)]), { model: 'example', effort: 'medium', now });
  assert.equal(r.status, 'estimated'); assert.equal(r.inference.method, 'model-level-proxy'); assert.equal(r.intelligenceIndex, 25);
});
test('inference cannot cross model generations, similar names or missing numeric data', () => {
  const s = make([...records, modelRecord('new', 'Example 2 (Max)', null)]);
  for (const model of ['example-2', 'example-pro', 'unknown']) {
    assert.equal(assessRating(s, { model, effort: 'ultra', now }).usableForRouting, false);
  }
  assert.equal(assessRating(s, { model: 'example', effort: 'automatic', now }).usableForRouting, false);
});
test('published estimates remain estimates and never become measured anchors', () => {
  const s = make([modelRecord('estimated', 'Example (Max)', 41, { intelligenceIndexIsEstimated: true })]);
  const r = assessRating(s, { model: 'example', effort: 'max', now });
  assert.equal(r.inference.method, 'published-estimate'); assert.equal(r.verified, false);
  assert.equal(assessRating(s, { model: 'example', effort: 'ultra', now }).usableForRouting, false);
});
test('stale or ambiguous anchors cannot support an inferred score', () => {
  const s = make(records); s.models.forEach(r => { r.observedAt = new Date(now - 169 * 3600000).toISOString(); });
  assert.equal(assessRating(s, { model: 'example', effort: 'ultra', now }).usableForRouting, false);
  const ambiguous = make([...records, modelRecord('max-copy', 'Example (Max)', 42)]);
  assert.equal(assessRating(ambiguous, { model: 'example', effort: 'max', now }).status, 'ambiguous');
  assert.equal(assessRating(ambiguous, { model: 'example', effort: 'ultra', now }).usableForRouting, false);
});
test('inference is deterministic, leaves the source intact, and strict mode remains opt-in', () => {
  const s = make(records), before = JSON.stringify(s);
  const args = { model: 'example', effort: 'ultra', now };
  assert.deepEqual(assessRating(s, args), assessRating({ ...s, models: s.models.toReversed() }, args));
  assert.equal(JSON.stringify(s), before);
  assert.equal(assessRating(s, { ...args, allowEstimates: false }).usableForRouting, false);
});
test('an inferred parent permits explicit task allocation while strict routing blocks; effort caps still apply', () => {
  const s = make(records);
  const request = { schemaVersion: 1, parent: { model: 'example', effort: 'ultra' }, task: { kind: 'design', profile: 'test-v1' },
    catalog: [{ model: 'example', efforts: ['low', 'high', 'max', 'ultra'] }], inheritSpeed: true, priority: 'normal', evidence: [] };
  const r = routeTask(s, request, policy, { now });
  assert.equal(r.status, 'task-policy-route'); assert.equal(r.usesEstimatedRatings, true);
  assert.equal(r.selection.effort, 'max'); assert.equal(r.selection.inherit, false);
  assert.equal(r.ceilingBasis, 'estimated-reference');
  assert.equal(routeTask(s, { ...request, allowEstimates: false }, policy, { now }).status, 'blocked');
  const lower = { ...request, parent: { model: 'example', effort: 'max' }, catalog: [{ model: 'example', efforts: ['ultra'] }] };
  assert.equal(routeTask(s, lower, policy, { now }).candidates[0].reason, 'above-parent-ceiling');
});
