import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startRoutedServer } from '../lib/launcher.mjs';
import { demoData } from '../examples/demo-data.mjs';

const root = path.resolve(import.meta.dirname, '..');
async function server(t, extra = []) {
  const directory = await mkdtemp(path.join(tmpdir(), 'cdr-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = demoData(); context.snapshot.synthetic = false;
  const routed = await startRoutedServer({ context, stateDirectory: directory,
    command: [process.execPath, path.join(root, 'fixtures/fake-codex.mjs'), ...extra] });
  t.after(() => routed.close());
  return { routed, directory };
}
async function client(t, socket, name = 'native_tui_fixture') {
  const ws = new WebSocket(`ws+unix://${socket}:/`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  let sequence = 0; const pending = new Map(), notices = [];
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.id !== undefined && pending.has(message.id)) {
      const task = pending.get(message.id); pending.delete(message.id); clearTimeout(task.timer);
      if (message.error) task.reject(message.error); else task.resolve(message.result);
    } else notices.push(message);
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  await request('initialize', { clientInfo: { name, version: 'test' } });
  ws.send(JSON.stringify({ method: 'initialized' }));
  return { request, notices };
}

test('native WebSocket client and MCP helper share one live owner and see real mode changes', async t => {
  const { routed, directory } = await server(t);
  const tui = await client(t, routed.socket);
  const helper = await client(t, routed.socket, 'codex_difficulty_router');
  const started = await tui.request('thread/start', { model: 'demo-strong',
    serviceTier: 'ultrafast', config: { model_reasoning_effort: 'ultra' } });
  const id = started.thread.id;
  const input = [{ type: 'text', text: 'Fix a spelling typo.' }];
  const external = { user_context: { kind: 'application', value: 'User-provided data.' } };
  await tui.request('turn/start', { threadId: id, input, additionalContext: external });
  let actual = await helper.request('thread/resume', { threadId: id, excludeTurns: true });
  assert.equal(actual.model, 'demo-small'); assert.equal(actual.reasoningEffort, 'low');
  assert.equal(actual.serviceTier, 'default');
  let state = JSON.parse(await readFile(path.join(directory, 'sessions', `${id}.json`), 'utf8'));
  assert.equal(state.applied, true); assert.equal(state.source, 'native-settings-readback');
  assert.equal(state.mode.model, actual.model);
  await tui.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Investigate a cross-module refactor.' }] });
  actual = await helper.request('thread/resume', { threadId: id, excludeTurns: true });
  assert.equal(actual.model, 'demo-strong'); assert.notEqual(actual.reasoningEffort, 'low');
  const before = actual.reasoningEffort;
  await tui.request('turn/start', { threadId: id, input: [{ type: 'text', text: '继续' }] });
  actual = await helper.request('thread/resume', { threadId: id, excludeTurns: true });
  assert.equal(actual.reasoningEffort, before); // No-op emits no settings event.
  assert.equal(JSON.parse(await readFile(routed.configFile, 'utf8')).rootThreadId, id);
});

test('host readback mismatch stops before inference rather than reporting a switch', async t => {
  const { routed } = await server(t, ['--reject-settings']);
  const tui = await client(t, routed.socket);
  const created = await tui.request('thread/start', {});
  await assert.rejects(tui.request('turn/start', { threadId: created.thread.id,
    input: [{ type: 'text', text: 'Fix a spelling typo.' }] }), error => error.data?.code === 'HOST_MODE_MISMATCH');
  assert.equal(tui.notices.some(n => n.method === 'turn/completed'), false);
});
