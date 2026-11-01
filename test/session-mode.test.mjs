import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readCurrentMode } from '../lib/session-mode.mjs';

const id = '01a1919e-ba8e-77e0-9453-8aed53916a2a';
const other = '01a1919e-ba8e-77e0-9453-8aed53916a2b';
const record = (type, payload) => JSON.stringify({ type, payload, timestamp: '2026-11-01T10:00:00Z' });
const records = () => [record('session_meta', { id }), record('event_msg', { type: 'task_started', turn_id: 'turn-2' }),
  record('response_item', { type: 'message', content: 'PRIVATE TEXT model=fake effort=low' }),
  record('turn_context', { turn_id: 'turn-2', model: 'gpt-6-astra', effort: 'ultra' })];
async function fixture(t, lines = records()) {
  const home = await mkdtemp(path.join(tmpdir(), 'router-context-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, 'sessions/2026/11/01'); await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-test-${id}.jsonl`); await writeFile(file, lines.join('\n') + '\n');
  return { home, file, dir, read: () => readCurrentMode({ codexHome: home, threadId: id, expectedTurnId: 'turn-2' }) };
}
test('reads only the active identified thread mode without transcript content or config defaults', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, 'config.toml'), 'model = "wrong-default"\n');
  await writeFile(path.join(f.dir, `rollout-other-${other}.jsonl`), 'invalid unrelated log');
  const r = await f.read(); assert.equal(r.status, 'resolved');
  assert.deepEqual(r.mode, { model: 'gpt-6-astra', effort: 'ultra' });
  assert.equal(r.provenance.threadId, id); assert.equal(r.speedStatus, 'not-recorded');
  assert.ok(!JSON.stringify(r).includes('PRIVATE TEXT'));
});
test('latest turn context wins and explicit recorded service tiers are mapped', async t => {
  const f = await fixture(t, [...records(), record('turn_context', { turn_id: 'turn-2', model: 'gpt-6.1-sol', effort: 'medium', service_tier: 'priority' })]);
  assert.deepEqual((await f.read()).mode, { model: 'gpt-6.1-sol', effort: 'medium', speed: 'fast' });
});
test('a new turn without its own context cannot reuse the previous mode', async t => {
  const f = await fixture(t, [...records(), record('event_msg', { type: 'task_started', turn_id: 'turn-3' })]);
  assert.equal((await f.read()).reason, 'active-turn-context-pending');
});
test('completed and aborted turns are not current active context', async t => {
  for (const type of ['task_complete', 'turn_aborted']) {
    const f = await fixture(t, [...records(), record('event_msg', { type, turn_id: 'turn-2' })]);
    assert.equal((await f.read()).reason, 'turn-no-longer-active');
  }
});
test('mismatched identity, conflicting effort and partial logs fail visibly', async t => {
  const f = await fixture(t, [record('session_meta', { id: other }), ...records().slice(1)]);
  assert.equal((await f.read()).reason, 'session-identity-mismatch');
  await writeFile(f.file, [...records(), record('turn_context', { turn_id: 'turn-2', model: 'example', effort: 'low', reasoning_effort: 'high' })].join('\n'));
  assert.equal((await f.read()).reason, 'exact-mode-missing-or-conflicting');
  await writeFile(f.file, records().join('\n') + '\n{"type":"turn_context"');
  assert.equal((await f.read()).reason, 'incomplete-or-invalid-session-log');
});
test('missing thread IDs, duplicate files and symlinks cannot select another session', async t => {
  assert.equal((await readCurrentMode({ threadId: '../other' })).status, 'unavailable');
  const f = await fixture(t);
  const duplicate = path.join(f.dir, `rollout-copy-${id}.jsonl`);
  await writeFile(duplicate, records().join('\n'));
  assert.equal((await f.read()).reason, 'ambiguous-session-files');
  await rm(duplicate); await rm(f.file); await writeFile(duplicate, records().join('\n'));
  await symlink(duplicate, f.file);
  assert.equal((await f.read()).status, 'resolved'); // Only the real, identity-checked file is selected.
  await rm(duplicate);
  assert.equal((await f.read()).reason, 'current-session-not-found');
});
