import path from 'node:path';
import { requireValue } from './ratings.mjs';
import { assessTask } from './assess.mjs';
import { routeTask } from './route.mjs';

function scopePath(value) {
  requireValue(typeof value === 'string' && value.length > 0 && !path.posix.isAbsolute(value)
    && !value.split(/[\\/]/).includes('..') && !/[\0*?]/.test(value), 'INVALID_SCOPE', 'Write scopes must be explicit relative paths without traversal or wildcards.');
  return value.replaceAll('\\', '/').replace(/\/$/, '');
}

export function planTasks({ tasks, parent, context, cwd, depth = 0 }) {
  const { config } = context;
  requireValue(config.autoThreads === true, 'AUTO_THREADS_DISABLED', 'Enable autoThreads in the user-owned routing config.');
  requireValue(depth === 0, 'MAX_DECOMPOSITION_DEPTH', 'Children may not recursively fan out.');
  requireValue(Array.isArray(tasks) && tasks.length >= 1 && tasks.length <= config.maxThreads, 'THREAD_LIMIT', 'Task count exceeds the configured thread limit.');
  const ids = new Set();
  const planned = tasks.map(task => {
    requireValue(typeof task.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(task.id) && !ids.has(task.id), 'INVALID_TASK_ID', 'Task ids must be unique and stable.');
    ids.add(task.id);
    requireValue(typeof task.prompt === 'string' && task.prompt.trim().length > 0
      && typeof task.acceptance === 'string' && task.acceptance.trim().length > 0, 'INVALID_TASK', 'Every task requires a prompt and verifiable acceptance criteria.');
    requireValue(typeof task.readOnly === 'boolean', 'UNKNOWN_WRITE_SCOPE', 'Declare readOnly for every task.');
    const writePaths = (task.writePaths ?? []).map(scopePath);
    requireValue(task.readOnly ? writePaths.length === 0 : writePaths.length > 0, 'UNKNOWN_WRITE_SCOPE', 'Writers need explicit write paths; read-only tasks cannot declare writes.');
    requireValue(task.cwd == null || path.resolve(task.cwd) === path.resolve(cwd), 'UNVERIFIED_WORKSPACE', 'Use the parent checkout; isolated worktree support requires a separate verified adapter.');
    const dependencies = task.dependsOn ?? [];
    requireValue(Array.isArray(dependencies) && dependencies.every(x => typeof x === 'string'), 'INVALID_DEPENDENCIES', 'dependsOn must contain task ids.');
    const assessment = assessTask({ prompt: task.prompt, project: context.project, metadata: task.metadata });
    return { ...task, cwd, writePaths, dependsOn: [...new Set(dependencies)],
      route: routeTask({ ...context, assessment, parent }) };
  });
  for (const task of planned) requireValue(task.dependsOn.every(id => ids.has(id) && id !== task.id), 'INVALID_DEPENDENCIES', 'Unknown or self-referencing dependency.');
  function batches() {
    const remaining = new Set(ids), done = new Set(), result = [];
    while (remaining.size) {
      const ready = planned.filter(t => remaining.has(t.id) && t.dependsOn.every(id => done.has(id))).map(t => t.id);
      requireValue(ready.length > 0, 'DEPENDENCY_CYCLE', 'Task dependency graph contains a cycle.');
      result.push(ready);
      ready.forEach(id => { remaining.delete(id); done.add(id); });
    }
    return result;
  }
  // Preserve semantic dependency order, then serialize writers in a shared
  // checkout. Even disjoint scopes can touch generated files or an index.
  const semanticOrder = batches().flat();
  let previous;
  const hasWriters = planned.some(t => !t.readOnly);
  for (const id of semanticOrder) {
    const task = planned.find(t => t.id === id);
    // Without an enforced read-set, readers can observe half-written changes.
    // Mixed read/write plans therefore serialize the shared checkout as well.
    if (hasWriters && previous && !task.dependsOn.includes(previous)) task.dependsOn.push(previous);
    previous = task.id;
  }
  const estimatedCost = planned.reduce((sum, task) => sum + task.route.selected.economics.estimatedCost, 0);
  requireValue(estimatedCost <= config.economics.maxPlanEstimatedCost, 'PLAN_BUDGET_EXCEEDED', 'Combined thread estimate exceeds the plan budget.');
  return { tasks: planned, batches: batches(), estimatedCost, unit: config.economics.unit,
    depth: 1, mode: 'independent-threads', childCeiling: parent, requiresHostExecution: true };
}
