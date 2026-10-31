import { EFFORTS, SPEEDS } from './assess.mjs';
import { ratingFor, validateRatings, requireValue, RoutingError } from './ratings.mjs';
import { estimateEconomics, rankEconomically } from './economics.mjs';

export function validateConfig(config) {
  requireValue(config?.version === 1 && ['codex', 'claude-code'].includes(config.host), 'INVALID_CONFIG', 'Expected version 1 and a supported host.');
  const c = config.ceiling;
  requireValue(c && typeof c.model === 'string' && c.model.length > 0 && EFFORTS.includes(c.effort) && SPEEDS.includes(c.speed),
    'INVALID_CONFIG', 'A model, effort and speed ceiling are required.');
  requireValue(Array.isArray(config.bindings), 'INVALID_CONFIG', 'bindings must be an array; exact host matches may fill an empty array.');
  requireValue(Number.isFinite(config.maxRatingAgeHours) && config.maxRatingAgeHours > 0, 'INVALID_CONFIG', 'Set a positive ratings age limit.');
  requireValue(Number.isInteger(config.maxThreads) && config.maxThreads >= 1 && config.maxThreads <= 16, 'INVALID_CONFIG', 'maxThreads must be 1–16.');
  requireValue(config.autoThreads === true || config.autoThreads === false, 'INVALID_CONFIG', 'Set autoThreads explicitly.');
  const e = config.economics;
  requireValue(e && typeof e.unit === 'string' && e.unit.length > 0 && Number.isFinite(e.maxEstimatedCost) && e.maxEstimatedCost > 0
    && Number.isFinite(e.maxPlanEstimatedCost) && e.maxPlanEstimatedCost > 0 && Number.isFinite(e.maxMetricsAgeHours)
    && e.maxMetricsAgeHours > 0 && e.tokenEstimate && e.latencyTargetsSeconds && Array.isArray(config.metrics),
  'INVALID_CONFIG', 'Configure cost unit, task/plan budgets, token estimates and exact-variant price/speed evidence.');
  return config;
}

export function normalizeCodexCatalog(models) {
  return models.filter(m => !m.hidden).map(m => {
    const speeds = { normal: 'default' };
    for (const tier of m.serviceTiers ?? []) {
      const id = typeof tier === 'string' ? tier : tier.id;
      if (id === 'fast' || id === 'priority') speeds.fast = id;
      if (id === 'ultrafast') speeds.ultrafast = id;
    }
    return {
      host: 'codex', model: m.model ?? m.id, ...(m.displayName ? { displayName: m.displayName } : {}),
      efforts: (m.supportedReasoningEfforts ?? []).map(e => typeof e === 'string' ? e : e.reasoningEffort), speeds
    };
  });
}

function ensureEnvelope(envelope, config, rows, catalog) {
  requireValue(envelope && EFFORTS.includes(envelope.effort) && SPEEDS.includes(envelope.speed), 'UNKNOWN_MAIN_MODE', 'Main chat effort and speed must be known; do not infer Ultra.');
  const available = catalog.find(m => m.host === config.host && m.model === envelope.model);
  requireValue(available && available.efforts.includes(envelope.effort) && available.speeds[envelope.speed], 'UNAVAILABLE_MAIN_MODE', 'The main mode is not advertised by the host catalog.');
  return { ...envelope, ...ratingFor(config.bindings, rows, config.host, envelope.model, envelope.effort) };
}

export function routeTask({ config, snapshot, catalog, assessment, parent, allowSynthetic = false, now = Date.now() }) {
  validateConfig(config);
  const rows = validateRatings(snapshot, { now, maxAgeHours: config.maxRatingAgeHours, allowSynthetic });
  requireValue(Array.isArray(catalog), 'INVALID_CATALOG', 'Host model catalog is required.');
  const root = ensureEnvelope(config.ceiling, config, rows, catalog);
  const cap = parent ? ensureEnvelope(parent, config, rows, catalog) : root;
  const maxScore = Math.min(root.intelligenceIndex, cap.intelligenceIndex);
  const maxEffort = Math.min(EFFORTS.indexOf(root.effort), EFFORTS.indexOf(cap.effort));
  const maxSpeed = Math.min(SPEEDS.indexOf(root.speed), SPEEDS.indexOf(cap.speed));
  const minEffort = EFFORTS.indexOf(assessment.minimumEffort);
  requireValue(minEffort >= 0 && SPEEDS.includes(assessment.requestedSpeed), 'INVALID_ASSESSMENT', 'Invalid task effort/speed.');
  requireValue(minEffort <= maxEffort, 'TASK_EXCEEDS_CEILING', 'The estimated task floor exceeds the main chat effort ceiling.');
  const candidates = [], excluded = [];
  for (const model of catalog.filter(m => m.host === config.host)) {
    for (const effort of model.efforts) {
      const rank = EFFORTS.indexOf(effort);
      if (rank < minEffort || rank > maxEffort) continue;
      try {
        const rating = ratingFor(config.bindings, rows, config.host, model.model, effort);
        if (rating.intelligenceIndex > maxScore) continue;
        const desired = Math.min(SPEEDS.indexOf(assessment.requestedSpeed), maxSpeed);
        for (const speed of SPEEDS.slice(0, desired + 1).filter(s => model.speeds[s])) {
          const candidate = { host: config.host, model: model.model, effort, speed,
            serviceTier: model.speeds[speed], ...rating };
          try {
            candidate.economics = estimateEconomics(candidate, assessment, config, now);
            if (candidate.economics.estimatedCost > config.economics.maxEstimatedCost) {
              excluded.push({ model: model.model, effort, speed, reason: 'TASK_BUDGET_EXCEEDED' });
            } else candidates.push(candidate);
          } catch (error) {
            if (!(error instanceof RoutingError)) throw error;
            excluded.push({ model: model.model, effort, speed, reason: error.code });
          }
        }
      } catch (error) {
        if (!(error instanceof RoutingError)) throw error;
        excluded.push({ model: model.model, effort, reason: error.code });
      }
    }
  }
  requireValue(candidates.length > 0, 'NO_ELIGIBLE_MODEL', 'No rated, available model variant fits the task and main chat ceilings.', { excluded });
  const scores = [...new Set(candidates.map(c => c.intelligenceIndex))].sort((a, b) => a - b);
  const percentile = { simple: 0, standard: 0.35, complex: 0.65, expert: 1 }[assessment.difficulty];
  requireValue(percentile !== undefined, 'INVALID_ASSESSMENT', 'Unknown task difficulty.');
  const scoreFloor = scores[Math.floor((scores.length - 1) * percentile)];
  const eligible = candidates.filter(c => c.intelligenceIndex >= scoreFloor);
  const { selected, latencyTargetSeconds, latencyTargetMet } = rankEconomically(eligible, assessment, config);
  return {
    selected, assessment, latencyTargetSeconds, latencyTargetMet,
    bounds: { minimumEffort: assessment.minimumEffort, minimumIntelligenceIndex: scoreFloor,
      maximumIntelligenceIndex: maxScore, maximumEffort: EFFORTS[maxEffort], maximumSpeed: SPEEDS[maxSpeed] },
    speedReason: selected.speed === assessment.requestedSpeed ? `Task priority: ${assessment.priority}.`
      : `Requested up to ${assessment.requestedSpeed}; selected ${selected.speed} under the price budget, latency target, availability and main cap.`,
    subagents: { allowed: selected.effort === 'ultra', required: false, preference: 'independent-threads',
      ceiling: { model: selected.model, effort: selected.effort, speed: selected.speed, intelligenceIndex: selected.intelligenceIndex } },
    excluded, indexVersion: String(snapshot.indexVersion),
    attribution: 'Intelligence Index: Artificial Analysis — https://artificialanalysis.ai/'
  };
}

export function assertWithinParent(candidate, parent, context) {
  const { config, snapshot, catalog } = context;
  const result = routeTask({ ...context, parent, assessment: {
    difficulty: 'simple', minimumEffort: candidate.effort, requestedSpeed: candidate.speed, priority: 'normal'
  } });
  const rows = validateRatings(snapshot, { maxAgeHours: config.maxRatingAgeHours, now: context.now });
  const rating = ratingFor(config.bindings, rows, config.host, candidate.model, candidate.effort);
  const model = catalog.find(m => m.host === config.host && m.model === candidate.model);
  requireValue(model?.efforts.includes(candidate.effort) && model?.speeds[candidate.speed], 'UNAVAILABLE_VARIANT', 'Requested variant is unavailable.');
  requireValue(rating.intelligenceIndex <= result.bounds.maximumIntelligenceIndex
    && EFFORTS.indexOf(candidate.effort) <= EFFORTS.indexOf(result.bounds.maximumEffort)
    && SPEEDS.indexOf(candidate.speed) <= SPEEDS.indexOf(result.bounds.maximumSpeed), 'CHILD_EXCEEDS_PARENT', 'Child mode exceeds its main chat.');
  return { ...candidate, ...rating };
}
