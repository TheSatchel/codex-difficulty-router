import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publicModelRecords, decodePublicData, fetchLeaderboard, normalizePublicModels } from '../lib/leaderboard.mjs';
import { ratingsCache } from '../lib/ratings-cache.mjs';
import { matchAvailableModels } from '../lib/model-match.mjs';
import { leaderboardFixture, modelRecord } from '../fixtures/leaderboard.mjs';
import { codexBinary } from '../lib/config.mjs';

test('all-model cache retains hundreds of vendors/variants, including retired and unrated entries', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cdr-full-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const records = Array.from({ length: 350 }, (_, i) => modelRecord(`example-${i}`, `Example ${i} (High)`, i % 3 ? null : 40,
    { deprecated: i >= 100, modelCreatorName: `Fictional Creator ${i % 30}` }));
  const fixture = leaderboardFixture(records);
  const cached = await ratingsCache({ directory, fetchImpl: fixture.fetchImpl });
  assert.equal(cached.usable, true); assert.equal(cached.snapshot.models.length, 350);
  assert.equal(cached.snapshot.coverage.deprecated, 250); assert.equal(cached.snapshot.coverage.currentPageRows, 100);
  assert.deepEqual(cached.snapshot.models[0].raw, records[0]);
  assert.equal(fixture.calls.length, 2); // One page + one complete data package.
});

test('page-data parser joins split JSON frames without executing page scripts', () => {
  const fixture = leaderboardFixture([modelRecord('a', 'A (Low)', 20)]);
  const parsed = publicModelRecords(fixture.html);
  assert.equal(parsed.records[0].slug, 'a'); assert.equal(parsed.manifest.path, '/data/test-fixture.txt');
  assert.equal(decodePublicData(fixture.encrypted, fixture.manifest.key)[0].intelligenceIndex, 20);
  assert.throws(() => decodePublicData(fixture.encrypted, 'bad'), { code: 'WEB_SCHEMA_CHANGED' });
});

test('a package missing a visible current model is rejected as incomplete', async () => {
  const fixture = leaderboardFixture([modelRecord('a', 'A (Low)', 20)], { current: [modelRecord('b', 'B (Low)', 30)] });
  await assert.rejects(fetchLeaderboard({ fetchImpl: fixture.fetchImpl }), { code: 'INCOMPLETE_LEADERBOARD' });
});

test('price, latency, speed, benchmark fields and nulls are preserved with units', () => {
  const snapshot = normalizePublicModels([modelRecord('a', 'A (Low)', null, { price1mInputTokens: 0, medianOutputTokensPerSecond: null })], { indexVersion: '5.0' });
  assert.equal(snapshot.models[0].publicMetrics.inputPerMillion, 0);
  assert.equal(snapshot.models[0].publicMetrics.outputTokensPerSecond, null);
  assert.equal(snapshot.models[0].publicMetrics.speedTier, 'unspecified');
  assert.equal(snapshot.models[0].publicMetrics.unit, 'USD');
  assert.equal(snapshot.models[0].intelligenceIndex, null);
});

test('selection intersects the complete cache with actual host IDs and efforts', () => {
  const snapshot = normalizePublicModels([
    modelRecord('future-low', 'Future Model (Low)', 30), modelRecord('future-max', 'Future Model (Max)', 60),
    modelRecord('other-high', 'Other Model (High)', 80)
  ], { indexVersion: '5.0' });
  const catalog = [{ host: 'codex', model: 'future-model', displayName: 'Future Model', efforts: ['low', 'max', 'ultra'], speeds: { normal: 'default' } }];
  const result = matchAvailableModels(snapshot, catalog);
  assert.equal(result.bindings.length, 2); assert.ok(result.bindings.every(b => b.model === 'future-model'));
  assert.equal(result.coverage.availableModels, 1);
  assert.equal(result.coverage.variants.find(v => v.effort === 'ultra').status, 'not-in-leaderboard');
});

test('runtime model additions are discovered without a hard-coded product whitelist', () => {
  const snapshot = normalizePublicModels([modelRecord('new-vendor-model', 'New Vendor Model (High)', 50)], { indexVersion: '5.0' });
  const a = matchAvailableModels(snapshot, []); assert.equal(a.bindings.length, 0);
  const b = matchAvailableModels(snapshot, [{ host: 'codex', model: 'new-vendor-model', efforts: ['high'] }]);
  assert.equal(b.bindings.length, 1);
});

test('missing scores, estimated scores, fallback variants and near-name aliases never become callable', () => {
  const snapshot = normalizePublicModels([
    modelRecord('model-low', 'Model (Low)', null),
    modelRecord('model-high', 'Model (High)', 40, { intelligenceIndexIsEstimated: true }),
    modelRecord('model-max', 'Model (Max, Default Fallback)', 70),
    modelRecord('model-plus-high', 'Model Plus (High)', 70)
  ], { indexVersion: '5.0' });
  const result = matchAvailableModels(snapshot, [{ host: 'codex', model: 'model', efforts: ['low', 'high', 'max'] }]);
  assert.equal(result.bindings.length, 0);
});

test('similar versions do not share a rating and ambiguous exact matches are excluded', () => {
  const snapshot = normalizePublicModels([
    modelRecord('gpt-6-1-sol-high', 'GPT-6.1 Sol (High)', 50),
    modelRecord('gpt-6-1-sol-high-alt', 'GPT-6.1 Sol (High)', 51)
  ], { indexVersion: '5.0' });
  const result = matchAvailableModels(snapshot, [
    { host: 'codex', model: 'gpt-6-sol', efforts: ['high'] }, { host: 'codex', model: 'gpt-6.1-sol', efforts: ['high'] }
  ]);
  assert.equal(result.bindings.length, 0);
  assert.equal(result.coverage.variants[0].status, 'not-in-leaderboard');
  assert.equal(result.coverage.variants[1].status, 'ambiguous');
});

test('desktop installs prefer their bundled Codex executable over an unrelated old PATH CLI', () => {
  const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  assert.equal(codexBinary({ platform: 'darwin', exists: candidate => candidate === bundled }), bundled);
  assert.equal(codexBinary({ platform: 'darwin', exists: () => false }), 'codex');
  assert.equal(codexBinary({ platform: 'linux', exists: () => true }), 'codex');
});
