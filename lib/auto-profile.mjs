import { EFFORTS, SPEEDS } from './assess.mjs';
import { normalizeCodexCatalog, validateConfig } from './route.mjs';
import { matchAvailableModels } from './model-match.mjs';
import { validateRatings, requireValue } from './ratings.mjs';

// Reviewed public pricing policy, not an account balance or an API invoice.
// Never extrapolate a throughput multiplier: the host only advertises a tier.
export const speedPolicy = {
  sourceUrl: 'https://learn.chatgpt.com/docs/agent-configuration/speed',
  reviewedAt: '2026-10-31T00:00:00.000Z',
  purchasedCreditMultipliers: { normal: 1, fast: 2, ultrafast: 6 },
  includedUsageMultipliers: { normal: 1, fast: 2.5, ultrafast: 8 }
};

export function automaticProfile({ snapshot, models, ceiling, maxEffort, maxSpeed = 'ultrafast',
  model, maxCost = 0.1, maxPlanCost = 0.3, policy = speedPolicy, now = Date.now() }) {
  const rows = validateRatings(snapshot, { now, maxAgeHours: 168 });
  const catalog = normalizeCodexCatalog(models);
  const { bindings, coverage } = matchAvailableModels(snapshot, catalog);
  const rated = bindings.map(b => ({ ...b, row: rows.get(b.aaSlug) }));
  requireValue(rated.length, 'NO_RATED_HOST_MODEL', 'No measured leaderboard variant matches the live Codex catalog.');
  requireValue(SPEEDS.includes(maxSpeed) && (!maxEffort || EFFORTS.includes(maxEffort)), 'INVALID_CEILING', 'Unknown effort/speed cap.');
  let root = ceiling;
  if (!root) {
    const defaults = models.filter(m => m.isDefault).map(m => m.model ?? m.id);
    const candidates = rated.filter(b => (!model || b.model === model)
      && (!maxEffort || EFFORTS.indexOf(b.effort) <= EFFORTS.indexOf(maxEffort)));
    candidates.sort((a, b) => Number(defaults.includes(b.model)) - Number(defaults.includes(a.model))
      || b.row.intelligenceIndex - a.row.intelligenceIndex);
    const selected = candidates[0];
    requireValue(selected, 'UNRATED_CEILING', 'The requested maximum has no exact measured, available variant.');
    const available = catalog.find(m => m.model === selected.model);
    const speed = SPEEDS.filter(s => available.speeds[s] && SPEEDS.indexOf(s) <= SPEEDS.indexOf(maxSpeed)).at(-1);
    root = { model: selected.model, effort: selected.effort, speed };
  }
  const freshPolicy = Date.parse(policy.reviewedAt) <= now + 300_000
    && now - Date.parse(policy.reviewedAt) <= 168 * 3_600_000;
  const metrics = rated.flatMap(binding => {
    const p = binding.row.publicMetrics, available = catalog.find(m => m.model === binding.model);
    if (!p || p.unit !== 'USD' || !Number.isFinite(p.inputPerMillion) || !Number.isFinite(p.outputPerMillion)
      || !(p.outputTokensPerSecond > 0) || !Number.isFinite(p.ttftSeconds)) return [];
    return Object.keys(available.speeds).filter(s => s === 'normal' || freshPolicy).map(speed => ({
      host: 'codex', model: binding.model, effort: binding.effort, speed,
      unit: 'API-price-equivalent USD', fetchedAt: binding.row.observedAt ?? snapshot.fetchedAt,
      sourceUrl: binding.row.evidenceUrl,
      inputPerMillion: p.inputPerMillion * policy.purchasedCreditMultipliers[speed],
      outputPerMillion: p.outputPerMillion * policy.purchasedCreditMultipliers[speed],
      ttftSeconds: p.ttftSeconds, outputTokensPerSecond: p.outputTokensPerSecond,
      speedEvidence: speed === 'normal' ? 'benchmark-baseline' : 'host-advertised-tier',
      tierPricingSource: policy.sourceUrl, tierPricingReviewedAt: policy.reviewedAt,
      tokenEstimate: { reasoning: ({ none: 0, minimal: 64, low: 128, medium: 512,
        high: 1536, xhigh: 4096, max: 8192 })[binding.effort] ?? 8192 }
    }));
  });
  const config = validateConfig({ version: 1, host: 'codex', ratingsMode: 'leaderboard',
    ceiling: root, bindings, maxRatingAgeHours: 168, autoThreads: true, maxThreads: 4,
    economics: { unit: 'API-price-equivalent USD', maxEstimatedCost: maxCost,
      maxPlanEstimatedCost: maxPlanCost, maxMetricsAgeHours: 168,
      tokenEstimate: { input: 4000, output: 512, reasoning: 512 },
      latencyTargetsSeconds: { background: null, normal: null, high: 30, urgent: 10 },
      premiumCostRatio: { high: 2.5, urgent: 8 } }, metrics,
    costBasis: 'Leaderboard API-price equivalent with published ChatGPT purchased-credit tier ratios. Planning comparison only; not actual billing, a balance or a spending limit.',
    speedPolicy: policy
  });
  return { config, snapshot, catalog, coverage };
}
