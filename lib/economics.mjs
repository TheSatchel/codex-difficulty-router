import { requireValue } from './ratings.mjs';
import { SPEEDS } from './assess.mjs';

export function estimateEconomics(candidate, assessment, config, now = Date.now()) {
  const entries = config.metrics.filter(m => m.host === candidate.host && m.model === candidate.model
    && m.effort === candidate.effort && m.speed === candidate.speed);
  requireValue(entries.length === 1, 'MISSING_PRICE_OR_SPEED', 'A unique price and speed record is required for the exact variant/tier.');
  const metric = entries[0];
  requireValue(metric.unit === config.economics.unit, 'INCOMPARABLE_PRICES', 'Do not compare credits with USD or currencies without an explicit conversion.');
  const fetched = Date.parse(metric.fetchedAt);
  requireValue(Number.isFinite(fetched) && fetched <= now + 300_000
    && now - fetched <= config.economics.maxMetricsAgeHours * 3_600_000, 'STALE_METRICS', 'Refresh price/speed evidence.');
  requireValue(typeof metric.sourceUrl === 'string' && /^https:\/\//.test(metric.sourceUrl), 'INVALID_METRICS', 'Price/speed evidence URL is required.');
  for (const key of ['inputPerMillion', 'outputPerMillion', 'ttftSeconds']) {
    requireValue(typeof metric[key] === 'number' && Number.isFinite(metric[key]) && metric[key] >= 0, 'INVALID_METRICS', `Invalid ${key}.`);
  }
  requireValue(typeof metric.outputTokensPerSecond === 'number' && Number.isFinite(metric.outputTokensPerSecond)
    && metric.outputTokensPerSecond > 0, 'INVALID_METRICS', 'A positive observed output speed is required.');
  const tokens = { ...config.economics.tokenEstimate, ...metric.tokenEstimate, ...assessment.tokens };
  for (const key of ['input', 'output', 'reasoning']) requireValue(Number.isFinite(tokens[key]) && tokens[key] >= 0, 'INVALID_TOKEN_ESTIMATE', 'Token estimates must be nonnegative.');
  const estimatedCost = (tokens.input * metric.inputPerMillion + (tokens.output + tokens.reasoning) * metric.outputPerMillion) / 1_000_000;
  // Includes reasoning tokens, but excludes tool execution and variable queueing.
  // This is a planning estimate, never a billing or latency guarantee.
  const estimatedSeconds = metric.ttftSeconds + (tokens.output + tokens.reasoning) / metric.outputTokensPerSecond;
  return { estimatedCost,
    estimatedSeconds: metric.speedEvidence === 'host-advertised-tier' ? null : estimatedSeconds,
    benchmarkBaselineSeconds: estimatedSeconds, speedEvidence: metric.speedEvidence ?? 'explicit-metric',
    unit: metric.unit, tokens, sourceUrl: metric.sourceUrl, estimateOnly: true };
}

export function rankEconomically(candidates, assessment, config) {
  const target = config.economics.latencyTargetsSeconds[assessment.priority];
  const meetingTarget = typeof target === 'number' ? candidates.filter(c => Number.isFinite(c.economics.estimatedSeconds)
    && c.economics.estimatedSeconds <= target) : candidates;
  let pool = meetingTarget.length ? meetingTarget : candidates;
  if (!meetingTarget.length && candidates.some(c => c.economics.speedEvidence === 'host-advertised-tier')) {
    const cheapest = Math.min(...candidates.map(c => c.economics.estimatedCost));
    pool = candidates.filter(c => c.economics.estimatedCost <= cheapest * (config.economics.premiumCostRatio?.[assessment.priority] ?? 1));
    pool.sort((a, b) => SPEEDS.indexOf(b.speed) - SPEEDS.indexOf(a.speed)
      || a.economics.benchmarkBaselineSeconds - b.economics.benchmarkBaselineSeconds
      || a.economics.estimatedCost - b.economics.estimatedCost);
    return { selected: pool[0], latencyTargetSeconds: target, latencyTargetMet: false };
  }
  pool.sort((a, b) => (meetingTarget.length ? a.economics.estimatedCost - b.economics.estimatedCost
    : a.economics.estimatedSeconds - b.economics.estimatedSeconds)
    || a.economics.estimatedCost - b.economics.estimatedCost
    || a.intelligenceIndex - b.intelligenceIndex || a.model.localeCompare(b.model));
  return { selected: pool[0], latencyTargetSeconds: target ?? null, latencyTargetMet: target == null ? null : meetingTarget.length > 0 };
}
