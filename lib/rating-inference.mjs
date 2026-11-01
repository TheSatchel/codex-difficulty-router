import { canonicalID, variantFromName } from './model-match.mjs';

export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// A transparent heuristic over one exact model and one index version.
// These values are references for routing, never new benchmark measurements.
export function inferSameModel(snapshot, { model, effort, now = Date.now() }) {
  const target = EFFORT_ORDER.indexOf(effort);
  if (target < 0) return null;
  const pool = snapshot.models.map(row => row.baseName ? row : { ...row, ...variantFromName(row.name, row.raw?.isReasoning) })
    .filter(r => canonicalID(r.baseName) === model && Number.isFinite(r.intelligenceIndex)
      && /^https:\/\/artificialanalysis\.ai\//.test(r.evidenceUrl ?? '')
      && Number.isFinite(Date.parse(r.observedAt ?? snapshot.fetchedAt))
      && Date.parse(r.observedAt ?? snapshot.fetchedAt) <= now + 300000
      && now - Date.parse(r.observedAt ?? snapshot.fetchedAt) <= 168 * 3600000);
  const measured = pool.filter(r => !r.estimated);
  const ranked = measured.filter(r => r.exactVariant && EFFORT_ORDER.includes(r.evaluatedEffort))
    .map(r => ({ ...r, rank: EFFORT_ORDER.indexOf(r.evaluatedEffort) })).sort((a, b) => a.rank - b.rank);
  if (new Set(ranked.map(r => r.rank)).size !== ranked.length) return null;
  const lower = ranked.filter(r => r.rank < target).at(-1), upper = ranked.find(r => r.rank > target);
  let anchors, score, method;
  if (lower && upper) {
    anchors = [lower, upper]; method = 'same-model-interpolation';
    score = lower.intelligenceIndex + (upper.intelligenceIndex - lower.intelligenceIndex) * (target - lower.rank) / (upper.rank - lower.rank);
  } else {
    const base = measured.filter(r => r.evaluatedEffort == null && !r.evaluationOptions);
    if (base.length > 1) return null;
    if (base.length === 1) { anchors = base; score = base[0].intelligenceIndex; method = 'model-level-proxy'; }
    else if (ranked.length) {
      const closest = [...ranked].sort((a, b) => Math.abs(a.rank - target) - Math.abs(b.rank - target) || a.rank - b.rank)[0];
      anchors = [closest]; score = closest.intelligenceIndex; method = 'nearest-effort-proxy';
    } else {
      const published = pool.filter(r => r.estimated && r.exactVariant && r.evaluatedEffort === effort);
      if (published.length !== 1) return null;
      anchors = published; score = published[0].intelligenceIndex; method = 'published-estimate';
    }
  }
  return { intelligenceIndex: score, method, confidence: 'heuristic-not-calibrated',
    anchors: anchors.map(r => ({ aaSlug: r.slug, name: r.name, effort: r.evaluatedEffort,
      intelligenceIndex: r.intelligenceIndex, estimated: r.estimated === true,
      evidenceUrl: r.evidenceUrl, observedAt: r.observedAt ?? snapshot.fetchedAt })),
    observedAt: new Date(Math.min(...anchors.map(r => Date.parse(r.observedAt ?? snapshot.fetchedAt)))).toISOString() };
}
