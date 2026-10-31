import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { demoData } from '../examples/demo-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function setup(t, mutate = () => {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'cdr-test-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const ctx = demoData();
  // Only this fake transport is used with the fictional fixture marked as
  // non-demo. Never export these records as real leaderboard/pricing data.
  ctx.snapshot.synthetic = false; ctx.config.ratingsPath = path.join(folder, 'ratings.json');
  mutate(ctx);
  const configFile = path.join(folder, 'routing.json');
  await writeFile(configFile, JSON.stringify(ctx.config)); await writeFile(ctx.config.ratingsPath, JSON.stringify(ctx.snapshot));
  const log = path.join(folder, 'calls.jsonl');
  return { folder, ctx, log, env: { ...process.env, CDR_CONFIG: configFile, PLUGIN_DATA: path.join(folder, 'state'),
    CDR_CODEX_COMMAND: JSON.stringify([process.execPath, path.join(root, 'fixtures/fake-codex.mjs')]), CDR_TEST_LOG: log } };
}
async function cli(args, input, env) {
  const child = spawn(process.execPath, [path.join(root, 'bin/router.mjs'), ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
  const finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr })); });
  child.stdin.end(input); return finished;
}
async function calls(file) { try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }

test('offline demo never starts a backend', async () => {
  const result = await cli(['demo'], '', { ...process.env, CDR_CODEX_COMMAND: '["command-that-must-never-run"]' });
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).modelCalls, 0);
});

test('proxy changes model/effort/speed in real JSON-RPC fields, including collaboration precedence', async t => {
  const { env, log } = await setup(t);
  const messages = [
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' }, capabilities: { experimentalApi: true } } },
    { method: 'initialized' },
    { id: 2, method: 'thread/start', params: {} },
    { id: 3, method: 'turn/start', params: { threadId: 'main', input: [{ type: 'text', text: 'Fix a spelling typo.' }],
      serviceTierForTurn: 'ultrafast', collaborationMode: { mode: 'default', settings: { model: 'demo-strong', reasoning_effort: 'ultra', developer_instructions: null } } } }
  ];
  const result = await cli(['proxy'], messages.map(JSON.stringify).join('\n') + '\n', env);
  assert.equal(result.code, 0, result.stderr);
  const sent = await calls(log), turn = sent.find(x => x.method === 'turn/start');
  assert.ok(turn, result.stdout);
  assert.equal(turn.params.model, 'demo-small'); assert.equal(turn.params.effort, 'low');
  assert.equal(turn.params.serviceTier, 'default'); assert.equal(turn.params.serviceTierForTurn, 'default');
  assert.equal(turn.params.collaborationMode.settings.model, 'demo-small');
  assert.equal(turn.params.collaborationMode.settings.reasoning_effort, 'low');
  assert.equal(sent.find(x => x.method === 'thread/start').params.allowProviderModelFallback, false);
  assert.ok(result.stdout.split('\n').filter(Boolean).map(JSON.parse).some(x => x.id === 3 && x.result));
});

test('proxy never sends a model request if the main rating is missing', async t => {
  const { env, log } = await setup(t, c => { c.config.bindings.pop(); });
  const result = await cli(['proxy'], [
    { id: 1, method: 'initialize', params: {} }, { method: 'initialized' },
    { id: 2, method: 'turn/start', params: { threadId: 'main', input: [{ type: 'text', text: 'Fix typo.' }] } }
  ].map(JSON.stringify).join('\n') + '\n', env);
  assert.equal((await calls(log)).filter(x => x.method === 'turn/start').length, 0);
  const response = result.stdout.split('\n').filter(Boolean).map(JSON.parse).find(x => x.id === 2);
  assert.equal(response.error.data.code, 'UNRATED_VARIANT');
});

test('dispatcher creates normal threads, waits for results and never invokes subagents', async t => {
  const { env, log } = await setup(t);
  const request = { requestId: 'two-readers', parentThreadId: 'main', tasks: [
    { id: 'a', prompt: 'Check typo.', acceptance: 'Report finding.', readOnly: true },
    { id: 'b', prompt: 'Check another typo.', acceptance: 'Report finding.', readOnly: true }
  ] };
  const result = await cli(['dispatch'], JSON.stringify(request), env);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout); assert.equal(receipt.status, 'completed', JSON.stringify(receipt)); assert.equal(receipt.threads.length, 2);
  assert.ok(receipt.threads.every(x => x.result.startsWith('Result from mock-')));
  const sent = await calls(log); assert.equal(sent.filter(x => x.method === 'thread/start').length, 2);
  assert.equal(sent.filter(x => /spawn|subagent/.test(x.method ?? '')).length, 0);
  assert.ok(sent.filter(x => x.method === 'turn/start').every(x => x.params.sandboxPolicy.type === 'readOnly'));
  const again = await cli(['dispatch'], JSON.stringify(request), env);
  assert.equal(JSON.parse(again.stdout).threads[0].threadId, receipt.threads[0].threadId);
  assert.equal((await calls(log)).filter(x => x.method === 'thread/start').length, 2);
});

test('dependency failure stops later threads and preserves already-created ids', async t => {
  const { env, log } = await setup(t); env.CDR_TEST_FAIL_TURN = '1';
  const result = await cli(['dispatch'], JSON.stringify({ requestId: 'failure', parentThreadId: 'main', tasks: [
    { id: 'a', prompt: 'Check typo.', acceptance: 'Report.', readOnly: true },
    { id: 'b', prompt: 'Check typo.', acceptance: 'Report.', readOnly: true, dependsOn: ['a'] }
  ] }), env);
  const receipt = JSON.parse(result.stdout); assert.equal(receipt.status, 'needs_attention');
  assert.equal(receipt.threads.length, 1); assert.ok(receipt.threads[0].threadId);
  assert.equal((await calls(log)).filter(x => x.method === 'thread/start').length, 1);
});

test('MCP discovery and assessment work without model access or private config', async () => {
  const input = [
    { id: 1, method: 'initialize', params: {} },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'router_assess', arguments: { prompt: 'Urgent spelling typo.' } } }
  ];
  const result = await cli(['mcp'], input.map(JSON.stringify).join('\n') + '\n', { ...process.env, CDR_CODEX_COMMAND: '["must-not-run"]' });
  assert.equal(result.code, 0, result.stderr);
  const messages = result.stdout.split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(messages.find(x => x.id === 2).result.tools.length, 4);
  const value = JSON.parse(messages.find(x => x.id === 3).result.content[0].text); assert.equal(value.priority, 'urgent');
});

test('unrouted review and compaction cannot bypass the model-call gate', async t => {
  const { env, log } = await setup(t);
  const result = await cli(['proxy'], [
    { id: 1, method: 'initialize', params: {} }, { method: 'initialized' },
    { id: 2, method: 'review/start', params: { threadId: 'main' } },
    { id: 3, method: 'thread/compact/start', params: { threadId: 'main' } }
  ].map(JSON.stringify).join('\n') + '\n', env);
  assert.equal((await calls(log)).filter(x => ['review/start', 'thread/compact/start'].includes(x.method)).length, 0);
  const replies = result.stdout.split('\n').filter(Boolean).map(JSON.parse).filter(x => [2, 3].includes(x.id));
  assert.ok(replies.every(x => x.error.data.code === 'UNROUTED_INFERENCE_METHOD'));
});
