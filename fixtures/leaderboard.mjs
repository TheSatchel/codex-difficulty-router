// Fictional records and a generated public-loader fixture. No real API/data.
import { createCipheriv, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { LEADERBOARD_URL } from '../lib/leaderboard.mjs';

export function leaderboardFixture(records, { current = records.filter(r => !r.deprecated), version = '5.0' } = {}) {
  const material = Buffer.alloc(32, 17), iv = createHash('sha256').update(material).digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', material, iv);
  const compressed = gzipSync(Buffer.from(JSON.stringify(records)));
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
  const manifest = { path: '/data/test-fixture.txt', key: material.toString('hex') };
  const flight = `f:${JSON.stringify({ initialModels: current, manifest })}\n`;
  const split = Math.floor(flight.length / 2);
  const html = `<h1>Fictional leaderboard</h1><p>Artificial Analysis Intelligence Index v${version}</p>`
    + [flight.slice(0, split), flight.slice(split)].map(piece => `<script>self.__next_f.push(${JSON.stringify([1, piece])})</script>`).join('');
  const calls = [];
  const fetchImpl = async source => {
    calls.push(source);
    if (source === LEADERBOARD_URL) return { ok: true, text: async () => html };
    if (source === 'https://artificialanalysis.ai/data/test-fixture.txt') return { ok: true, arrayBuffer: async () => Uint8Array.from(encrypted).buffer };
    throw new Error(`Unexpected fixture URL: ${source}`);
  };
  return { html, encrypted, manifest, fetchImpl, calls };
}

export const modelRecord = (slug, name, intelligenceIndex, extra = {}) => ({
  slug, name, intelligenceIndex, modelCreatorName: 'Fictional Creator', deprecated: false, isReasoning: true,
  intelligenceIndexIsEstimated: false, price1mInputTokens: 1, price1mOutputTokens: 5,
  medianOutputTokensPerSecond: 100, medianTimeToFirstTokenSeconds: 1, scores: { fictional: 0.5 }, ...extra
});
