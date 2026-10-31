// All ids, scores, prices and timings here are fictional. Never used for calls.
export function demoData(now = Date.now()) {
  const fetchedAt = new Date(now).toISOString();
  const variants = [['demo-small', 'low', 30], ['demo-balanced', 'medium', 50], ['demo-strong', 'high', 65], ['demo-strong', 'xhigh', 70], ['demo-strong', 'ultra', 75]];
  const config = {
    version: 1, host: 'codex', ceiling: { model: 'demo-strong', effort: 'ultra', speed: 'ultrafast' },
    maxRatingAgeHours: 168, autoThreads: true, maxThreads: 4,
    economics: { unit: 'USD', maxEstimatedCost: 0.5, maxPlanEstimatedCost: 1,
      maxMetricsAgeHours: 168, tokenEstimate: { input: 4000, output: 1000, reasoning: 1000 },
      latencyTargetsSeconds: { background: null, normal: null, high: 15, urgent: 5 } },
    bindings: variants.map(([model, effort]) => ({ host: 'codex', model, effort,
      aaSlug: `${model}-${effort}`, evidenceUrl: `https://artificialanalysis.ai/models/${model}-${effort}` })),
    metrics: variants.flatMap(([model, effort]) => ['normal', 'fast', 'ultrafast'].map((speed, i) => ({
      host: 'codex', model, effort, speed, unit: 'USD', fetchedAt, sourceUrl: 'https://example.invalid/synthetic-metrics',
      inputPerMillion: (model === 'demo-small' ? 0.1 : 2) * [1, 2, 6][i],
      outputPerMillion: (model === 'demo-small' ? 0.5 : 10) * [1, 2, 6][i],
      ttftSeconds: 0.1, outputTokensPerSecond: (model === 'demo-small' ? 250 : 100) * [1, 2, 8][i]
    })))
  };
  const snapshot = { source: 'artificial-analysis', synthetic: true, indexVersion: '5.0', fetchedAt,
    models: variants.map(([model, effort, intelligenceIndex]) => ({ slug: `${model}-${effort}`, intelligenceIndex })) };
  const catalog = [...new Set(variants.map(v => v[0]))].map(model => ({ host: 'codex', model,
    efforts: variants.filter(v => v[0] === model).map(v => v[1]),
    speeds: { normal: 'default', fast: 'fast', ultrafast: 'ultrafast' } }));
  return { config, snapshot, catalog, allowSynthetic: true, now, project: { available: true, packageCount: 1 } };
}
