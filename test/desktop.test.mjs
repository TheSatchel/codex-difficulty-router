import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { serveDesktop } from '../lib/desktop-service.mjs';
import { desktopLaunchAgent } from '../lib/install-desktop.mjs';
import { demoData } from '../examples/demo-data.mjs';
import { VERSION } from '../lib/version.mjs';

async function connect(t, endpoint) {
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  const pending = new Map(); let sequence = 0;
  ws.on('message', data => {
    const m = JSON.parse(data.toString()), p = pending.get(m.id);
    if (!p) return; pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(m.error); else p.resolve(m.result);
  });
  return { ws, request: (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 6000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  }) };
}

test('desktop app connects to a cold Unix WebSocket backend and controls its own initialization', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cdr-desktop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = demoData(); context.snapshot.synthetic = false;
  const server = await serveDesktop({ socketDirectory: path.join(directory, 'socket'), stateDirectory: directory,
    command: [process.execPath, path.resolve(import.meta.dirname, '../fixtures/fake-codex.mjs')], context,
    queryPlugin: async () => ({ installed: true, enabled: true, version: VERSION }) });
  t.after(() => server.close());
  const initial = JSON.parse(await readFile(server.statusFile, 'utf8'));
  assert.equal(initial.initializedByApp, false); assert.equal(initial.running, true);
  const app = await connect(t, server.appEndpoint);
  const initialized = await app.request('initialize', { clientInfo: { name: 'codex_desktop_fixture', version: 'test' }, capabilities: { experimentalApi: true } });
  assert.equal(initialized.clientName, 'codex_desktop_fixture');
  app.ws.send(JSON.stringify({ method: 'initialized' }));
  app.ws.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.method === 'fixture/requestApproval') app.ws.send(JSON.stringify({ id: message.id, result: { decision: 'accept' } }));
  });
  assert.equal((await app.request('fixture/approval')).approved, true);
  const created = await app.request('thread/start', { model: 'demo-strong', config: { model_reasoning_effort: 'ultra' } });
  await app.request('turn/start', { threadId: created.thread.id, input: [{ type: 'text', text: 'Fix one spelling typo.' }] });
  const read = await app.request('thread/read', { threadId: created.thread.id, includeTurns: false });
  assert.equal(read.thread.model, 'demo-small'); assert.equal(read.thread.reasoningEffort, 'low');
  assert.equal(JSON.parse(await readFile(server.statusFile, 'utf8')).routingEnabled, true);
});

test('disabled desktop plugin keeps the app backend usable without rewriting model parameters', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cdr-desktop-off-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await serveDesktop({ socketDirectory: path.join(directory, 'socket'), stateDirectory: directory,
    command: [process.execPath, path.resolve(import.meta.dirname, '../fixtures/fake-codex.mjs')],
    queryPlugin: async () => ({ installed: false, enabled: false, version: null }) });
  t.after(() => server.close());
  const app = await connect(t, server.appEndpoint);
  await app.request('initialize', { clientInfo: { name: 'desktop_fixture', version: 'test' } });
  app.ws.send(JSON.stringify({ method: 'initialized' }));
  const created = await app.request('thread/start', { model: 'user-manual-model', config: { model_reasoning_effort: 'high' } });
  const read = await app.request('thread/read', { threadId: created.thread.id });
  assert.equal(read.thread.model, 'user-manual-model');
  assert.equal(JSON.parse(await readFile(server.statusFile, 'utf8')).routingEnabled, false);
});

test('LaunchAgent uses an explicit Node executable and escapes paths without a shell command', () => {
  const plist = desktopLaunchAgent({ node: '/path with spaces/node', script: '/a&b/router.mjs',
    logDirectory: '/private/logs', searchPath: '/usr/bin:/bin' });
  assert.match(plist, /<string>\/path with spaces\/node<\/string>/);
  assert.match(plist, /\/a&amp;b\/router.mjs/); assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.equal(plist.includes('/bin/sh'), false);
});
