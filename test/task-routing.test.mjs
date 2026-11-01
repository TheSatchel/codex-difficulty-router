import test from 'node:test';
import assert from 'node:assert/strict';
import { readJSON } from '../lib/ratings.mjs';
import { normalizePublicModels } from '../lib/leaderboard.mjs';
import { modelRecord } from '../fixtures/leaderboard.mjs';
import { routeTask } from '../lib/task-routing.mjs';

// Fictional modes/results test policy decisions; they are never live evidence.
const now = Date.parse('2026-11-01T10:00:00Z');
const policy = await readJSON(new URL('../data/routing-policy.json', import.meta.url));
const snapshot = normalizePublicModels([
  modelRecord('parent', 'Parent (Max)', 60), modelRecord('light', 'Light (Medium)', 30),
  modelRecord('fast', 'Fast (Medium)', 35), modelRecord('strong', 'Strong (Max)', 80),
  modelRecord('unrated', 'Unrated (Max)', null), modelRecord('light-ultra', 'Light (Ultra)', 40)
], { now, indexVersion: '5.0' });
const req = () => ({ schemaVersion: 1, parent: { model: 'parent', effort: 'max', speed: 'normal' },
  task: { kind: 'bounded-edit', profile: 'fixture-v1' }, catalog: [{ model: 'light', efforts: ['medium'] }],
  inheritSpeed: true, priority: 'normal', evidence: [] });
const evidence = (model = 'light', cost = 1, duration = 80) => [0, 1, 2].flatMap(i => [
  { id: `base-${i}`, taskId: `task-${i}`, model: 'parent', effort: 'max', cost: { amount: 4, unit: 'credits' }, durationMs: 100 },
  { id: `${model}-${i}`, taskId: `task-${i}`, model, effort: 'medium', cost: { amount: cost, unit: 'credits' }, durationMs: duration }
].map(e => ({ ...e, kind: 'bounded-edit', profile: 'fixture-v1', speed: 'normal', observedAt: new Date(now).toISOString(),
  verified: true, evidenceRef: `fixture:acceptance/${e.id}`, outcome: 'pass' })));
const run = r => routeTask(snapshot, r, policy, { now });

test('without task history the task policy selects an explicit mode, not parent inheritance', () => {
  const r = run(req()); assert.equal(r.status, 'task-policy-route');
  assert.equal(r.selection.model, 'light'); assert.equal(r.selection.effort, 'medium');
  assert.equal(r.selection.inherit, false); assert.equal(r.taskCapability, 'heuristic-not-validated');
});
test('comparable paired acceptance enables a cheaper route reproducibly', () => {
  const q = { ...req(), evidence: evidence() };
  const r = run(q); assert.equal(r.status, 'evidence-route'); assert.equal(r.selection.model, 'light');
  assert.equal(r.observedImprovement.candidateCost, 1);
  assert.deepEqual(run({ ...q, evidence: q.evidence.toReversed() }), r);
});
test('unrated parents and unsupported speed inheritance block explicit allocation', () => {
  assert.equal(run({ ...req(), parent: { model: 'unrated', effort: 'max' } }).reason, 'parent-rating-unverified');
  assert.equal(run({ ...req(), inheritSpeed: false }).reason, 'speed-inheritance-unverified');
});
test('task profile, speed, freshness and verified status prevent borrowed evidence', () => {
  for (const patch of [{ profile: 'different-v1' }, { speed: 'fast' }, { verified: false },
    { observedAt: new Date(now - 31 * 86400000).toISOString() }]) {
    assert.equal(run({ ...req(), evidence: evidence().map(e => ({ ...e, ...patch })) }).status, 'task-policy-route');
  }
  assert.equal(run({ ...req(), task: { kind: 'design', profile: 'fixture-v1' }, evidence: evidence() }).status, 'task-policy-route');
});
test('duplicate tasks cannot inflate the evidence count and retries must be aggregated', () => {
  const e = evidence(); assert.throws(() => run({ ...req(), evidence: [...e, { ...e[1], id: 'another-id' }] }), { code: 'DUPLICATE_EVIDENCE' });
  assert.equal(run({ ...req(), evidence: e.slice(0, 4) }).status, 'task-policy-route');
});
test('capability failure vetoes a candidate; environment failure is not an upgrade signal', () => {
  for (const outcome of ['capability-failure', 'environment-failure']) {
    const e = evidence(); e[1].outcome = outcome;
    const r = run({ ...req(), evidence: e }); assert.equal(r.status, outcome === 'capability-failure' ? 'blocked' : 'task-policy-route');
    if (outcome === 'capability-failure') assert.equal(r.candidates[0].reason, 'observed-capability-failure');
  }
});
test('unknown or changed speed cannot hide a known capability failure', () => {
  const e = evidence(); e[1].outcome = 'capability-failure';
  for (const speed of [undefined, 'fast']) {
    const q = { ...req(), parent: { model: 'parent', effort: 'max', ...(speed ? { speed } : {}) }, evidence: e };
    const r = run(q); assert.equal(r.status, 'blocked');
    assert.equal(r.candidates[0].reason, 'observed-capability-failure');
  }
});
test('perfect task evidence cannot bypass model and effort ceilings or actual availability', () => {
  const r = run({ ...req(), catalog: [{ model: 'strong', efforts: ['max'] }, { model: 'light', efforts: ['ultra'] }] });
  assert.ok(r.candidates.every(c => c.reason === 'above-parent-ceiling'));
  assert.equal(run({ ...req(), catalog: [], evidence: evidence() }).status, 'blocked');
});
test('mixed cost units and improvements that increase cost cannot justify an urgent route', () => {
  const e = evidence(); e[1].cost.unit = 'USD';
  assert.equal(run({ ...req(), evidence: e }).candidates[0].reason, 'incomparable-cost-units');
  const r = run({ ...req(), priority: 'urgent', evidence: evidence('light', 5, 50) });
  assert.equal(r.status, 'blocked'); assert.equal(r.candidates[0].reason, 'no-observed-improvement');
});
test('normal and urgent use cost and duration on identical paired tasks', () => {
  const e = [...evidence(), ...evidence('fast', 2, 50).filter(x => x.model === 'fast')];
  const q = { ...req(), catalog: [{ model: 'fast', efforts: ['medium'] }, ...req().catalog], evidence: e };
  assert.equal(run(q).selection.model, 'light');
  assert.equal(run({ ...q, priority: 'urgent' }).selection.model, 'fast');
});
test('different evaluation sets are not treated as comparable cost benchmarks', () => {
  const more = evidence('fast', 2, 50).map(e => ({ ...e, id: `extra-${e.id}`, taskId: `other-${e.taskId}` }));
  const r = run({ ...req(), catalog: [...req().catalog, { model: 'fast', efforts: ['medium'] }], evidence: [...evidence(), ...more] });
  assert.equal(r.reason, 'candidate-evidence-not-comparable');
});
test('malformed/future evidence and invented task IQ thresholds are rejected', () => {
  assert.throws(() => run({ ...req(), task: { ...req().task, iqThreshold: 40 } }), { code: 'INVALID_ROUTE_REQUEST' });
  assert.throws(() => run({ ...req(), evidence: evidence().map(e => ({ ...e, observedAt: new Date(now + 1).toISOString() })) }), { code: 'INVALID_EVIDENCE' });
});

test('four task kinds explicitly allocate different efforts and model tiers from the actual catalog', () => {
  const modes = ['low', 'medium', 'high', 'max'];
  const s = normalizePublicModels([modelRecord('parent-max', 'Parent (Max)', 100),
    ...['Small', 'Balanced', 'Strong'].flatMap((name, n) => modes.map((effort, e) => modelRecord(`${name}-${effort}`, `${name} (${effort})`, 10 + n * 20 + e)))
  ], { now, indexVersion: '5.0' });
  const catalog = ['small', 'balanced', 'strong'].map(model => ({ model, efforts: modes }));
  const expected = { transform: ['small', 'low'], 'bounded-edit': ['balanced', 'medium'], investigate: ['strong', 'high'], design: ['strong', 'max'] };
  for (const [kind, selection] of Object.entries(expected)) {
    const q = { ...req(), task: { kind, profile: 'test-v1' }, catalog };
    const r = routeTask(s, q, policy, { now });
    assert.deepEqual([r.selection.model, r.selection.effort], selection); assert.equal(r.selection.inherit, false);
    assert.deepEqual(routeTask(s, { ...q, catalog: catalog.toReversed() }, policy, { now }), r);
  }
  const limited = routeTask(s, { ...req(), parent: { model: 'parent', effort: 'medium' }, task: { kind: 'design', profile: 'test-v1' }, catalog }, policy, { now });
  assert.equal(limited.selection.effort, 'medium'); assert.equal(limited.effortLimitedByParent, true);
});
