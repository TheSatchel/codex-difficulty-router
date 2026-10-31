import path from 'node:path';
import { dataDirectory, saveJSON } from './config.mjs';
import { readJSON, requireValue } from './ratings.mjs';
import { speedPolicy } from './auto-profile.mjs';

export function parseSpeedPolicy(markdown, now = Date.now()) {
  const fast = markdown.split('## Fast mode')[1]?.split('## Ultrafast mode')[0];
  const ultra = markdown.split('## Ultrafast mode')[1]?.split('## Availability')[0];
  requireValue(fast && ultra, 'SPEED_POLICY_CHANGED', 'Official speed policy sections could not be verified.');
  const number = (text, pattern) => {
    const value = Number(text.match(pattern)?.[1]);
    requireValue(Number.isFinite(value) && value >= 1 && value <= 100, 'SPEED_POLICY_CHANGED', 'An explicit published tier multiplier is required.');
    return value;
  };
  return { sourceUrl: speedPolicy.sourceUrl, reviewedAt: new Date(now).toISOString(),
    purchasedCreditMultipliers: { normal: 1,
      fast: number(fast, /purchased credits[\s\S]{0,160}?billed at\s+([\d.]+)x/i),
      ultrafast: number(ultra, /bills purchased credits[\s\S]{0,160}?at\s+([\d.]+)x/i) },
    includedUsageMultipliers: { normal: 1,
      fast: number(fast, /included subscription limits at\s+([\d.]+)x/i),
      ultrafast: number(ultra, /included subscription limits at\s+([\d.]+)x/i) }
  };
}

export async function cachedSpeedPolicy({ file = path.join(dataDirectory(), 'speed-policy.json'),
  fetchImpl = fetch, now = Date.now(), cacheOnly = false } = {}) {
  let cached;
  try { cached = await readJSON(file); } catch (error) { if (error.code !== 'ENOENT') cached = null; }
  const previous = cached?.policy?.sourceUrl === speedPolicy.sourceUrl ? cached.policy : speedPolicy;
  if (cacheOnly) return previous;
  const last = Date.parse(cached?.attemptedAt);
  if (Number.isFinite(last) && last <= now && now - last < 300_000) return previous;
  try {
    const response = await fetchImpl(`${speedPolicy.sourceUrl}.md`, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    requireValue(response.ok, 'SPEED_POLICY_UNAVAILABLE', `Official speed policy HTTP ${response.status}.`);
    const text = await response.text();
    requireValue(text.length < 2_000_000, 'SPEED_POLICY_CHANGED', 'Unexpected speed policy size.');
    const policy = parseSpeedPolicy(text, now);
    await saveJSON(file, { policy, attemptedAt: new Date(now).toISOString(), status: 'updated' });
    return policy;
  } catch (error) {
    await saveJSON(file, { policy: previous, attemptedAt: new Date(now).toISOString(),
      status: 'cached', error: error.code ?? 'NETWORK_OR_FORMAT_ERROR' });
    return previous;
  }
}
