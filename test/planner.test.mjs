import test from 'node:test';
import assert from 'node:assert/strict';
import { planTasks } from '../lib/planner.mjs';
import { demoData } from '../examples/demo-data.mjs';

const task = (id, extra = {}) => ({ id, prompt: 'Check one typo.', acceptance: 'Report the exact line.', readOnly: true, ...extra });
const fixture = tasks => { const context = demoData(); return { tasks, parent: context.config.ceiling, context, cwd: '/project' }; };

test('independent read tasks become ordinary parallel thread batches', () => {
  const plan = planTasks(fixture([task('a'), task('b')]));
  assert.deepEqual(plan.batches, [['a', 'b']]);
  assert.equal(plan.mode, 'independent-threads'); assert.equal(plan.depth, 1);
});
test('dependency results run before consumers', () => {
  assert.deepEqual(planTasks(fixture([task('a'), task('b', { dependsOn: ['a'] })])).batches, [['a'], ['b']]);
});
test('writers in the same checkout serialize even with disjoint scopes', () => {
  const plan = planTasks(fixture([task('a', { readOnly: false, writePaths: ['src/a.mjs'] }), task('b', { readOnly: false, writePaths: ['src/b.mjs'] })]));
  assert.deepEqual(plan.batches, [['a'], ['b']]);
});
test('reverse semantic dependencies do not become artificial write cycles', () => {
  const plan = planTasks(fixture([task('a', { readOnly: false, writePaths: ['a'], dependsOn: ['b'] }), task('b', { readOnly: false, writePaths: ['b'] })]));
  assert.deepEqual(plan.batches, [['b'], ['a']]);
});
test('cycles and unknown dependencies stop before dispatch', () => {
  assert.throws(() => planTasks(fixture([task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })])), { code: 'DEPENDENCY_CYCLE' });
  assert.throws(() => planTasks(fixture([task('a', { dependsOn: ['missing'] })])), { code: 'INVALID_DEPENDENCIES' });
});
test('children cannot recursively split, and thread count is bounded', () => {
  assert.throws(() => planTasks({ ...fixture([task('a')]), depth: 1 }), { code: 'MAX_DECOMPOSITION_DEPTH' });
  assert.throws(() => planTasks(fixture(Array.from({ length: 5 }, (_, i) => task(`task${i}`)))), { code: 'THREAD_LIMIT' });
});
test('write scope traversal, undeclared writes and an unverified worktree stop', () => {
  assert.throws(() => planTasks(fixture([task('a', { readOnly: false })])), { code: 'UNKNOWN_WRITE_SCOPE' });
  assert.throws(() => planTasks(fixture([task('a', { readOnly: false, writePaths: ['../outside'] })])), { code: 'INVALID_SCOPE' });
  assert.throws(() => planTasks(fixture([task('a', { cwd: '/somewhere-else' })])), { code: 'UNVERIFIED_WORKSPACE' });
});
test('aggregate thread budget is checked in addition to per-task budgets', () => {
  const input = fixture([task('a'), task('b')]); input.context.config.economics.maxPlanEstimatedCost = 0.0015;
  assert.throws(() => planTasks(input), { code: 'PLAN_BUDGET_EXCEEDED' });
});
