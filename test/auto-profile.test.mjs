import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticProfile } from '../lib/auto-profile.mjs';
import { routeTask } from '../lib/route.mjs';
import { assessTask } from '../lib/assess.mjs';

// Fictional metadata only. No backend or real model ever receives this data.
function fixture() {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const models = ['sample-mini', 'sample-main', 'unrated-model'].map((model, i) => ({
    model, isDefault: i === 1, supportedReasoningEfforts: ['low', 'high', 'max', 'ultra'],
    serviceTiers: ['priority', 'ultrafast']
  }));
  const rows = models.flatMap((m, i) => ['low', 'high', 'max'].map((effort, j) => ({
    slug: `${m.model}-${effort}`, name: `${m.model} (${effort})`, baseName: m.model,
    exactVariant: true, evaluatedEffort: effort, intelligenceIndex: i === 2 ? null : 20 + i * 20 + j,
    estimated: false, observedAt: new Date(now).toISOString(), evidenceUrl: `https://artificialanalysis.ai/models/${m.model}-${effort}`,
    publicMetrics: { unit: 'USD', inputPerMillion: i ? 2 : 0.1, outputPerMillion: i ? 10 : 0.5,
      outputTokensPerSecond: i ? 60 : 150, ttftSeconds: 1 }
  })));
  return { now, models, snapshot: { source: 'artificial-analysis', indexVersion: '5.0', fetchedAt: new Date(now).toISOString(), models: rows } };
}

test('automatic setup intersects all ratings with the real host without placeholders or unrated calls', () => {
  const f = fixture(), ctx = automaticProfile(f);
  assert.deepEqual(ctx.config.ceiling, { model: 'sample-main', effort: 'max', speed: 'ultrafast' });
  assert.equal(ctx.config.metrics.some(m => m.model === 'unrated-model' || m.effort === 'ultra'), false);
  const result = routeTask({ ...ctx, now: f.now, assessment: assessTask({ prompt: 'Fix a spelling typo.' }) });
  assert.equal(result.selected.model, 'sample-mini'); assert.equal(result.selected.speed, 'normal');
  assert.equal(result.selected.economics.unit, 'API-price-equivalent USD');
});

test('premium tiers have a price penalty but never invent measured speed multipliers', () => {
  const ctx = automaticProfile(fixture());
  const normal = ctx.config.metrics.find(m => m.model === 'sample-main' && m.effort === 'low' && m.speed === 'normal');
  const ultra = ctx.config.metrics.find(m => m.model === normal.model && m.effort === normal.effort && m.speed === 'ultrafast');
  assert.equal(ultra.inputPerMillion, normal.inputPerMillion * 6);
  assert.equal(ultra.outputTokensPerSecond, normal.outputTokensPerSecond);
  assert.equal(ultra.speedEvidence, 'host-advertised-tier');
});

test('explicit maximum cannot authorize an unscored variant or exceed supported effort', () => {
  const f = fixture();
  const ctx = automaticProfile({ ...f, maxEffort: 'high', maxSpeed: 'normal' });
  assert.equal(ctx.config.ceiling.effort, 'high'); assert.equal(ctx.config.ceiling.speed, 'normal');
  assert.throws(() => automaticProfile({ ...f, model: 'unrated-model' }), { code: 'UNRATED_CEILING' });
});
