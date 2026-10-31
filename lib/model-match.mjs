const normalizedName = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const canonicalID = value => normalizedName(value).replace(/\s+/g, '-');

export function variantFromName(name, isReasoning) {
  const match = /^(.*?)\s*\((none|minimal|low|medium|high|xhigh|max|ultra|non-reasoning)([^)]*)\)\s*$/i.exec(name ?? '');
  if (match) return { baseName: match[1].trim(), evaluatedEffort: match[2].toLowerCase() === 'non-reasoning' ? 'none' : match[2].toLowerCase(),
    evaluationOptions: match[3].trim().replace(/^,\s*/, ''), exactVariant: match[3].trim() === '' };
  return { baseName: name, evaluatedEffort: isReasoning === false ? 'none' : null, evaluationOptions: '', exactVariant: isReasoning === false };
}

// The cache is a superset. Host model/list is the sole source of callable IDs,
// efforts and service tiers. This matches whole names/IDs, never fuzzy aliases.
export function matchAvailableModels(snapshot, catalog, explicit = []) {
  const bindings = [], variants = [];
  for (const model of catalog) {
    for (const effort of model.efforts) {
      const manual = explicit.filter(b => b.host === model.host && b.model === model.model && b.effort === effort);
      const matches = (snapshot.models ?? []).filter(row => {
        const v = row.baseName ? row : { ...row, ...variantFromName(row.name, row.raw?.isReasoning) };
        return v.exactVariant === true && v.evaluatedEffort === effort
          && (canonicalID(v.baseName) === model.model || (model.displayName && normalizedName(v.baseName) === normalizedName(model.displayName)));
      });
      if (manual.length) {
        bindings.push(...manual);
        const row = snapshot.models.find(r => r.slug === manual[0].aaSlug);
        variants.push({ model: model.model, effort, status: manual.length !== 1 ? 'ambiguous'
          : row?.intelligenceIndex != null && row.estimated !== true ? 'matched' : 'unrated', source: 'explicit', aaSlug: row?.slug });
      } else if (matches.length === 1) {
        const row = matches[0];
        const status = row.intelligenceIndex === null || row.estimated === true ? 'unrated' : 'matched';
        if (status === 'matched') bindings.push({ host: model.host, model: model.model, effort,
          aaSlug: row.slug, evidenceUrl: row.evidenceUrl, matchedBy: 'exact-host-name-and-effort' });
        variants.push({ model: model.model, effort, status, aaSlug: row.slug });
      } else variants.push({ model: model.model, effort, status: matches.length ? 'ambiguous' : 'not-in-leaderboard' });
    }
  }
  // Preserve explicit entries for the configured ceiling, while never adding
  // any unavailable ID to the host catalog used by the actual routing loop.
  const keys = new Set(bindings.map(b => `${b.host}/${b.model}/${b.effort}`));
  for (const b of explicit) if (!keys.has(`${b.host}/${b.model}/${b.effort}`)) bindings.push(b);
  return { bindings, coverage: { cachedModels: snapshot.models?.length ?? 0, availableModels: catalog.length,
    availableVariants: variants.length, matchedVariants: variants.filter(v => v.status === 'matched').length,
    variants, modelCalls: 0 } };
}
