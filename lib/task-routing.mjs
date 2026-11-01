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
    && Array.isArray(policy.taskKinds) && Array.isArray(policy.effortOrder), 'INVALID_POLICY', 'Invalid routing policy.');
  requireValue(sameKeys(request, ['schemaVersion', 'parent', 'task', 'catalog', 'inheritSpeed', 'priority', 'evidence'])
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
  const parent = assessRating(snapshot, { ...request.parent, now });
  result.parentRating = parent;
  if (!parent.verified) return blocked('parent-rating-unverified');
  const baseline = reason => ({ ...result, status: 'parent-baseline', reason, taskCapability: 'unvalidated',
    selection: { model: parent.model, effort: parent.effort, inherit: true, speed: 'inherit' } });
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
  if (request.evidence.length && !['normal', 'fast', 'ultrafast'].includes(request.parent.speed)) return baseline('parent-speed-unknown-for-evidence');
  const relevant = request.evidence.filter(e => e.verified && e.kind === request.task.kind && e.profile === request.task.profile
    && e.speed === request.parent.speed && now - Date.parse(e.observedAt) <= policy.evidenceMaxAgeDays * 86400000);
  const baseRecords = new Map(relevant.filter(e => key(e) === key(parent) && e.outcome === 'pass').map(e => [e.taskId, e]));
  const choices = new Map();
  for (const m of request.catalog) for (const effort of m.efforts) choices.set(key({ model: m.model, effort }), { model: m.model, effort });
  const eligible = [];
  for (const candidate of [...choices.values()].sort((a, b) => key(a).localeCompare(key(b), 'en'))) {
    if (key(candidate) === key(parent)) continue;
    const rating = assessRating(snapshot, { ...candidate, now });
    const diagnostic = { ...candidate, ratingStatus: rating.status, reason: null };
    result.candidates.push(diagnostic);
    if (!rating.verified) { diagnostic.reason = 'rating-unverified'; continue; }
    if (rating.intelligenceIndex > parent.intelligenceIndex || policy.effortOrder.indexOf(candidate.effort) > policy.effortOrder.indexOf(parent.effort)) {
      diagnostic.reason = 'above-parent-ceiling'; continue;
    }
    const records = relevant.filter(e => key(e) === key(candidate));
    if (records.some(e => e.outcome === 'capability-failure')) { diagnostic.reason = 'observed-capability-failure'; continue; }
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
    if (!improves) { diagnostic.reason = 'no-observed-improvement'; continue; }
    diagnostic.reason = 'eligible'; eligible.push({ ...candidate, stats });
  }
  if (!eligible.length) return baseline('no-validated-improving-route');
  const comparisons = new Set(eligible.map(e => JSON.stringify([e.stats.pairedTasks, e.stats.unit])));
  if (comparisons.size !== 1) return baseline('candidate-evidence-not-comparable');
  const metric = request.priority === 'normal' ? 'candidateCost' : 'candidateDurationMs';
  eligible.sort((a, b) => a.stats[metric] - b.stats[metric] || key(a).localeCompare(key(b), 'en'));
  const selected = eligible[0];
  return { ...result, status: 'evidence-route', reason: 'paired-acceptance-and-observed-improvement',
    taskCapability: 'supported-by-reported-evidence',
    selection: { model: selected.model, effort: selected.effort, inherit: false, speed: 'inherit' },
    observedImprovement: selected.stats };
}
