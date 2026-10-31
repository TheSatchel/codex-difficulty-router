import test from 'node:test';
import assert from 'node:assert/strict';
import { demoData } from '../examples/demo-data.mjs';
import { assessTask } from '../lib/assess.mjs';
import { routeTask, assertWithinParent, normalizeCodexCatalog } from '../lib/route.mjs';
import { validateRatings, fetchRatings } from '../lib/ratings.mjs';
import { guardDelegation } from '../lib/hooks.mjs';
import { claudeArguments } from '../lib/claude.mjs';

const fixture = () => demoData();
const assessment = (prompt, metadata = {}) => assessTask({ prompt, project: { available: true }, metadata });
const run = (context, prompt = 'Fix a spelling typo.', metadata = {}) => routeTask({ ...context, assessment: assessment(prompt, metadata) });

test('small sufficient model wins routine work on price; speed and effort are independent', () => {
  const result = run(fixture());
  assert.equal(result.selected.model, 'demo-small');
  assert.equal(result.selected.effort, 'low');
  assert.equal(result.selected.speed, 'normal');
  assert.equal(result.selected.serviceTier, 'default');
});

test('an expert background task keeps deep reasoning at normal speed', () => {
  const result = run(fixture(), 'Background batch: cross-module refactor for an unknown concurrency migration.');
  assert.equal(result.assessment.priority, 'background');
  assert.equal(result.selected.speed, 'normal');
  assert.equal(result.selected.effort, 'ultra');
});

test('urgent expert task selects ultrafast only when its estimate meets target and budget', () => {
  const result = run(fixture(), 'P0 production outage: unknown concurrency architecture migration.');
  assert.equal(result.selected.speed, 'ultrafast');
  assert.equal(result.latencyTargetMet, true);
});

test('expensive universal ultrafast mode loses when normal already meets the latency target', () => {
  const ctx = fixture(); ctx.config.economics.latencyTargetsSeconds.urgent = 100;
  assert.equal(run(ctx, 'Urgent architecture concurrency migration.').selected.speed, 'normal');
});

test('ultrafast cannot exceed the task estimate budget; no free premium fallback', () => {
  const ctx = fixture(); ctx.config.economics.maxEstimatedCost = 0.04;
  const result = run(ctx, 'Urgent architecture concurrency migration.');
  assert.equal(result.selected.speed, 'normal');
  assert.equal(result.latencyTargetMet, false);
  assert.ok(result.excluded.some(x => x.reason === 'TASK_BUDGET_EXCEEDED'));
});

test('missing Intelligence Index is excluded, never scored as zero', () => {
  const ctx = fixture(); ctx.snapshot.models[0].intelligenceIndex = null;
  const result = run(ctx);
  assert.notEqual(result.selected.model, 'demo-small');
  assert.ok(result.excluded.some(x => x.model === 'demo-small' && x.reason === 'UNRATED_VARIANT'));
});

test('an unavailable high-effort variant never inherits another variant rating', () => {
  const ctx = fixture(); ctx.config.bindings = ctx.config.bindings.filter(b => b.model !== 'demo-small');
  assert.notEqual(run(ctx).selected.model, 'demo-small');
});

test('an unrated main ceiling fails closed before candidate routing', () => {
  const ctx = fixture(); ctx.config.bindings.pop();
  assert.throws(() => run(ctx), { code: 'UNRATED_VARIANT' });
});

test('synthetic snapshots cannot authorize production routing', () => {
  const ctx = fixture(); ctx.allowSynthetic = false;
  assert.throws(() => run(ctx), { code: 'SYNTHETIC_RATINGS' });
});

test('stale and future snapshots cannot authorize routing', () => {
  const ctx = fixture(); ctx.snapshot.fetchedAt = '2020-01-01T00:00:00Z';
  assert.throws(() => run(ctx), { code: 'STALE_RATINGS' });
  ctx.snapshot.fetchedAt = new Date(Date.now() + 3_600_000).toISOString();
  assert.throws(() => run(ctx), { code: 'STALE_RATINGS' });
});

test('NaN, negative, duplicate and coerced ratings are rejected', () => {
  for (const score of [NaN, -1, '45', false]) {
    const ctx = fixture(); ctx.snapshot.models[0].intelligenceIndex = score;
    assert.throws(() => validateRatings(ctx.snapshot, { allowSynthetic: true }), { code: 'INVALID_RATINGS' });
  }
  const ctx = fixture(); ctx.snapshot.models.push(ctx.snapshot.models[0]);
  assert.throws(() => run(ctx), { code: 'INVALID_RATINGS' });
});

test('parent bounds constrain score, reasoning and speed together', () => {
  const ctx = fixture(); const parent = { model: 'demo-strong', effort: 'high', speed: 'fast' };
  const result = routeTask({ ...ctx, parent, assessment: assessment('Urgent fix.', { difficulty: 'complex' }) });
  assert.ok(result.selected.intelligenceIndex <= 65);
  assert.equal(result.selected.effort, 'high');
  assert.notEqual(result.selected.speed, 'ultrafast');
});

test('task effort floor above parent ceiling stops instead of under-solving', () => {
  const ctx = fixture(); const parent = { model: 'demo-balanced', effort: 'medium', speed: 'normal' };
  assert.throws(() => routeTask({ ...ctx, parent, assessment: assessment('Concurrency migration of unknown architecture.') }), { code: 'TASK_EXCEEDS_CEILING' });
});

test('unknown main effort does not imply Ultra', () => {
  const ctx = fixture();
  assert.throws(() => routeTask({ ...ctx, parent: { model: 'demo-strong', speed: 'normal' }, assessment: assessment('Fix typo.') }), { code: 'UNKNOWN_MAIN_MODE' });
});

test('missing price/speed evidence and incomparable billing units are excluded', () => {
  const ctx = fixture(); ctx.config.metrics = [];
  assert.throws(() => run(ctx), { code: 'NO_ELIGIBLE_MODEL' });
  const other = fixture(); other.config.metrics.forEach(m => { m.unit = 'credits'; });
  assert.throws(() => run(other), { code: 'NO_ELIGIBLE_MODEL' });
});

test('model availability and service tiers come from the host, without probing', () => {
  const catalog = normalizeCodexCatalog([
    { model: 'exact-id', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], serviceTiers: [{ id: 'priority' }] },
    { model: 'hidden-id', hidden: true, supportedReasoningEfforts: [] }
  ]);
  assert.deepEqual(catalog, [{ host: 'codex', model: 'exact-id', efforts: ['high'], speeds: { normal: 'default', fast: 'priority' } }]);
});

test('large projects alone do not escalate a typo; urgency alone does not require a bigger model', () => {
  const a = assessTask({ prompt: 'Fix a spelling typo.', project: { available: true, packageCount: 100 } });
  const b = assessment('Urgent spelling typo.');
  assert.equal(a.difficulty, 'simple'); assert.equal(b.difficulty, 'simple'); assert.equal(b.priority, 'urgent');
});

test('subagents are denied outside Ultra; native thread calls use the guarded dispatcher', () => {
  const ctx = fixture(); const state = { mode: { effort: 'high' } };
  assert.equal(guardDelegation({ tool_name: 'multi_agent_v1__spawn_agent' }, state, ctx).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(guardDelegation({ tool_name: 'Agent' }, state, ctx).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(guardDelegation({ tool_name: 'mcp__codex_app__create_thread' }, state, ctx).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(guardDelegation({ tool_name: 'Read' }, state, ctx), {});
});

test('Ultra permits optional bounded subagents; score or speed escalation is denied', () => {
  const ctx = fixture(); ctx.snapshot.synthetic = false;
  const state = { mode: { model: 'demo-strong', effort: 'ultra', speed: 'fast' }, depth: 0, catalog: ctx.catalog };
  const allowed = guardDelegation({ tool_name: 'spawn_agent', tool_input: { model: 'demo-balanced', reasoning_effort: 'medium', speed: 'normal' } }, state, ctx);
  assert.deepEqual(allowed, {});
  const blocked = guardDelegation({ tool_name: 'spawn_agent', tool_input: { speed: 'ultrafast' } }, state, ctx);
  assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
  assert.throws(() => assertWithinParent({ model: 'unrated', effort: 'high', speed: 'normal' }, state.mode, ctx), { code: 'UNRATED_VARIANT' });
});

test('Claude launcher uses exact model, effort, speed and session flags without shell strings', () => {
  const args = claudeArguments({ selected: { model: 'exact-claude-id', effort: 'high', speed: 'normal' }, prompt: 'hello', sessionId: 'uuid', pluginRoot: '/plugin root' });
  assert.equal(args[1], 'exact-claude-id'); assert.ok(args.includes('/plugin root'));
  assert.equal(JSON.parse(args[5]).fastMode, false);
  assert.throws(() => claudeArguments({ selected: { effort: 'high', speed: 'ultrafast' } }), { code: 'UNSUPPORTED_CLAUDE_SPEED' });
});

test('AA refresh follows pagination and preserves missing scores', async () => {
  const calls = [];
  const snapshot = await fetchRatings({ apiKey: 'test-key-not-real', fetchImpl: async url => {
    calls.push(url); const page = calls.length;
    return { ok: true, json: async () => ({ intelligence_index_version: 5,
      pagination: { has_more: page === 1 }, data: [{ slug: `model-${page}`, name: `Model ${page}`,
        evaluations: { artificial_analysis_intelligence_index: page === 1 ? 60 : null } }] }) };
  } });
  assert.equal(calls.length, 2); assert.equal(snapshot.models[1].intelligenceIndex, null);
});

test('AA mixed index versions are rejected instead of compared', async () => {
  let page = 0;
  await assert.rejects(fetchRatings({ apiKey: 'fake', fetchImpl: async () => ({ ok: true,
    json: async () => ({ intelligence_index_version: ++page === 1 ? 4 : 5, pagination: { has_more: page === 1 }, data: [] }) }) }), { code: 'MIXED_INDEX_VERSIONS' });
});
