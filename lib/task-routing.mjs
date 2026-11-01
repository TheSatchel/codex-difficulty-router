import { assessRating } from './rating-assessment.mjs';
import { requireValue } from './ratings.mjs';

const nonempty = x => typeof x === 'string' && x.trim().length > 0;
const finite = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const key = x => JSON.stringify([x.model, x.effort]);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sameKeys = (o, allowed) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => allowed.includes(k));

export function routeTask(snapshot, request, policy, { now = Date.now() } = {}) {
  requireValue(policy?.schemaVersion === 1 && Number.isInteger(policy.minPairedTasks) && policy.minPairedTasks >= 1
    && finite(policy.evidenceMaxAgeDays) && policy.evidenceMaxAgeDays > 0
    && Array.isArray(policy.taskKinds) && Array.isArray(policy.effortOrder)
    && policy.taskKinds.every(k => policy.effortOrder.includes(policy.initialAllocation?.[k]?.effort)
      && ['economy', 'balanced', 'strong'].includes(policy.initialAllocation[k].modelTier)), 'INVALID_POLICY', 'Invalid routing policy.');
  requireValue(sameKeys(request, ['schemaVersion', 'parent', 'task', 'catalog', 'inheritSpeed', 'priority', 'evidence', 'allowEstimates'])
    && (request.allowEstimates === undefined || typeof request.allowEstimates === 'boolean')
    && request.schemaVersion === 1 && sameKeys(request.parent, ['model', 'effort', 'speed'])
    && nonempty(request.parent?.model) && policy.effortOrder.includes(request.parent?.effort)
    && sameKeys(request.task, ['kind', 'profile']) && policy.taskKinds.includes(request.task?.kind) && nonempty(request.task?.profile)
    && ['normal', 'urgent'].includes(request.priority) && Array.isArray(request.catalog)
    && request.catalog.every(x => nonempty(x?.model) && Array.isArray(x.efforts) && x.efforts.every(e => policy.effortOrder.includes(e)))
    && Array.isArray(request.evidence), 'INVALID_ROUTE_REQUEST', 'Provide a supported task, actual parent/catalog, priority and evidence array.');
  const result = { modelCalls: 0, task: request.task, priority: request.priority, policy: {
    minPairedTasks: policy.minPairedTasks, evidenceMaxAgeDays: policy.evidenceMaxAgeDays }, candidates: [] };
  const blocked = reason => ({ ...result, status: 'blocked', reason, selection: null });
  if (request.inheritSpeed !== true) return blocked('speed-inheritance-unverified');
  const allowEstimates = request.allowEstimates !== false;
  const parent = assessRating(snapshot, { ...request.parent, now, allowEstimates });
  result.parentRating = parent;
  result.allowEstimates = allowEstimates;
  result.usesEstimatedRatings = parent.estimated;
  result.ceilingBasis = parent.estimated ? 'estimated-reference' : 'measured-index';
  if (!parent.usableForRouting) return blocked('parent-rating-unverified');
  const seen = new Set(), trials = new Set();
  for (const e of request.evidence) {
    requireValue(nonempty(e?.id) && nonempty(e.taskId) && nonempty(e.profile) && policy.taskKinds.includes(e.kind)
      && nonempty(e.model) && policy.effortOrder.includes(e.effort) && typeof e.verified === 'boolean'
      && nonempty(e.evidenceRef) && ['normal', 'fast', 'ultrafast'].includes(e.speed)
      && ['pass', 'capability-failure', 'environment-failure'].includes(e.outcome)
      && Number.isFinite(Date.parse(e.observedAt)) && Date.parse(e.observedAt) <= now
      && finite(e.durationMs) && finite(e.cost?.amount) && ['USD', 'credits'].includes(e.cost?.unit),
    'INVALID_EVIDENCE', 'Evidence needs exact mode, verified outcome/provenance, total duration and comparable cost.');
    const trial = JSON.stringify([key(e), e.taskId, e.kind, e.profile, e.speed]);
    requireValue(!seen.has(e.id) && !trials.has(trial), 'DUPLICATE_EVIDENCE', 'Aggregate retries; duplicate records cannot increase sample count.');
    seen.add(e.id); trials.add(trial);
  }
  const speedKnownForEvidence = ['normal', 'fast', 'ultrafast'].includes(request.parent.speed);
  const recent = request.evidence.filter(e => e.verified && e.kind === request.task.kind && e.profile === request.task.profile
    && now - Date.parse(e.observedAt) <= policy.evidenceMaxAgeDays * 86400000);
  const relevant = recent.filter(e => e.speed === request.parent.speed);
  const baseRecords = new Map(relevant.filter(e => key(e) === key(parent) && e.outcome === 'pass').map(e => [e.taskId, e]));
  const choices = new Map();
  for (const m of request.catalog) for (const effort of m.efforts) choices.set(key({ model: m.model, effort }), { model: m.model, effort });
  const eligible = [], admitted = [], contradicted = new Set();
  for (const candidate of [...choices.values()].sort((a, b) => key(a).localeCompare(key(b), 'en'))) {
    const rating = assessRating(snapshot, { ...candidate, now, allowEstimates });
    const diagnostic = { ...candidate, ratingStatus: rating.status, rating, reason: null };
    result.candidates.push(diagnostic);
    if (!rating.usableForRouting) { diagnostic.reason = 'rating-unverified'; continue; }
    if (rating.intelligenceIndex > parent.intelligenceIndex || policy.effortOrder.indexOf(candidate.effort) > policy.effortOrder.indexOf(parent.effort)) {
      diagnostic.reason = 'above-parent-ceiling'; continue;
    }
    const records = relevant.filter(e => key(e) === key(candidate));
    if (recent.some(e => key(e) === key(candidate) && e.outcome === 'capability-failure')) { diagnostic.reason = 'observed-capability-failure'; continue; }
    admitted.push({ ...candidate, rating });
    if (!speedKnownForEvidence) { diagnostic.reason = 'parent-speed-unknown-for-evidence'; continue; }
    const pairs = records.filter(e => e.outcome === 'pass' && baseRecords.has(e.taskId)).sort((a, b) => a.taskId.localeCompare(b.taskId, 'en'));
    if (pairs.length < policy.minPairedTasks) { diagnostic.reason = 'insufficient-paired-evidence'; continue; }
    const all = pairs.flatMap(e => [e, baseRecords.get(e.taskId)]);
    const units = new Set(all.map(e => e.cost.unit));
    if (units.size !== 1) { diagnostic.reason = 'incomparable-cost-units'; continue; }
    const stats = { pairedTasks: pairs.map(e => e.taskId), unit: all[0].cost.unit,
      candidateCost: mean(pairs.map(e => e.cost.amount)), parentCost: mean(pairs.map(e => baseRecords.get(e.taskId).cost.amount)),
      candidateDurationMs: mean(pairs.map(e => e.durationMs)), parentDurationMs: mean(pairs.map(e => baseRecords.get(e.taskId).durationMs)) };
    const improves = request.priority === 'normal' ? stats.candidateCost < stats.parentCost
      : stats.candidateCost <= stats.parentCost && stats.candidateDurationMs < stats.parentDurationMs;
    if (!improves) {
      diagnostic.reason = 'no-observed-improvement';
      if (stats.candidateCost > stats.parentCost || (request.priority === 'urgent' && stats.candidateDurationMs > stats.parentDurationMs)) contradicted.add(key(candidate));
      continue;
    }
    diagnostic.reason = 'eligible'; eligible.push({ ...candidate, stats, rating });
  }
  const allocate = reason => {
    const rule = policy.initialAllocation[request.task.kind];
    const targetRank = Math.min(policy.effortOrder.indexOf(rule.effort), policy.effortOrder.indexOf(parent.effort));
    const byModel = new Map();
    for (const candidate of admitted) {
      if (contradicted.has(key(candidate))) continue;
      const rank = policy.effortOrder.indexOf(candidate.effort);
      if (rank > targetRank) continue;
      const current = byModel.get(candidate.model);
      if (!current || rank > policy.effortOrder.indexOf(current.effort)) byModel.set(candidate.model, candidate);
    }
    // Compare models at the same closest supported effort, never mix Max and Low rankings.
    const closestRank = Math.max(-1, ...[...byModel.values()].map(c => policy.effortOrder.indexOf(c.effort)));
    const candidates = [...byModel.values()].filter(c => policy.effortOrder.indexOf(c.effort) === closestRank)
      .sort((a, b) => a.rating.intelligenceIndex - b.rating.intelligenceIndex || key(a).localeCompare(key(b), 'en'));
    if (!candidates.length) return blocked('no-admissible-task-allocation');
    const index = rule.modelTier === 'economy' ? 0 : rule.modelTier === 'balanced' ? Math.floor((candidates.length - 1) / 2) : candidates.length - 1;
    const selected = candidates[index];
    return { ...result, status: 'task-policy-route', reason, taskCapability: 'heuristic-not-validated',
      taskPolicy: rule, effortLimitedByParent: targetRank < policy.effortOrder.indexOf(rule.effort),
      costOptimization: 'not-established', usesEstimatedRatings: parent.estimated || selected.rating.estimated,
      selection: { model: selected.model, effort: selected.effort, inherit: false, speed: 'inherit' }, selectedRating: selected.rating };
  };
  if (!eligible.length) return allocate('task-policy-without-comparable-evidence');
  const comparisons = new Set(eligible.map(e => JSON.stringify([e.stats.pairedTasks, e.stats.unit])));
  if (comparisons.size !== 1) return allocate('candidate-evidence-not-comparable');
  const metric = request.priority === 'normal' ? 'candidateCost' : 'candidateDurationMs';
  eligible.sort((a, b) => a.stats[metric] - b.stats[metric] || key(a).localeCompare(key(b), 'en'));
  const selected = eligible[0];
  return { ...result, status: 'evidence-route', reason: 'paired-acceptance-and-observed-improvement',
    usesEstimatedRatings: parent.estimated || selected.rating.estimated,
    taskCapability: 'supported-by-reported-evidence',
    selection: { model: selected.model, effort: selected.effort, inherit: false, speed: 'inherit' },
    selectedRating: selected.rating,
    observedImprovement: selected.stats };
}
