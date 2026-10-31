// Uses the same Unix WebSocket URL as the desktop app. No model inference.
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { readJSON, requireValue } from '../lib/ratings.mjs';
import { applyVerifiedMode } from '../lib/codex.mjs';
import { EventEmitter } from 'node:events';
import { configuredCache, saveJSON } from '../lib/config.mjs';
import { normalizeCodexCatalog } from '../lib/route.mjs';
import { matchAvailableModels } from '../lib/model-match.mjs';

const config = await readJSON(path.join(os.homedir(), '.codex/difficulty-router/desktop-install.json'));
const require = createRequire(path.join(config.runtimeRoot, 'package.json'));
const { WebSocket } = require('ws');
const ws = new WebSocket(config.endpoint), pending = new Map();
const rpc = new EventEmitter(); let sequence = 0;
rpc.request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 30_000);
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
});
ws.on('message', data => {
  const message = JSON.parse(data.toString()), task = pending.get(message.id);
  if (message.method && message.id !== undefined) {
    console.error(JSON.stringify({ metadataProbeNeedsHostHandler: message.method }));
    ws.send(JSON.stringify({ id: message.id, error: { code: -32001, message: 'A metadata probe cannot grant permissions or provide an interactive app service.' } }));
    return;
  }
  if (task) {
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(Object.assign(new Error(message.error.message), { details: message.error }));
    else task.resolve(message.result);
  } else rpc.emit('notification', message);
});
try {
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await rpc.request('initialize', { clientInfo: { name: 'difficulty_router_desktop_probe', version: '1' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized' }));
  const { data: models } = await rpc.request('model/list', { limit: 100, includeHidden: false });
  const cached = await configuredCache({}, { cacheOnly: true });
  requireValue(cached.usable, 'RATINGS_UNAVAILABLE', 'A measured cache is required even for this zero-inference mode check.');
  const catalog = normalizeCodexCatalog(models), { bindings, coverage } = matchAvailableModels(cached.snapshot, catalog);
  const choices = bindings.filter(b => b.effort === 'low' || b.effort === 'high').slice(0, 2);
  requireValue(choices.length === 2, 'NO_VERIFIED_VARIANTS', 'Two rated host variants are required.');
  const first = choices[0];
  const created = await rpc.request('thread/start', { model: first.model, config: { model_reasoning_effort: first.effort },
    serviceTier: 'default', ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
  let previous = { model: created.model, effort: created.reasoningEffort, serviceTier: created.serviceTier };
  const verified = [];
  for (const choice of choices) {
    verified.push(await applyVerifiedMode(rpc, created.thread.id, { model: choice.model, effort: choice.effort,
      speed: 'normal', serviceTier: 'default' }, undefined, previous));
    previous = { model: choice.model, effort: choice.effort, serviceTier: 'default' };
  }
  const servers = await rpc.request('mcpServerStatus/list', { serverName: 'difficulty-router',
    threadId: created.thread.id, detail: 'toolsAndAuthOnly', limit: 100 });
  const own = servers.data.find(s => s.name === 'difficulty-router');
  requireValue(own && Object.keys(own.tools ?? {}).length === 4, 'MCP_UNAVAILABLE', 'Desktop router MCP tools were not discovered.');
  const report = { transport: 'desktop-app Unix WebSocket', modelCalls: 0, verified,
    cachedModels: cached.snapshot.models.length, matchedVariants: coverage.matchedVariants,
    mcpTools: Object.keys(own.tools), currentWindowVerified: false };
  await saveJSON(path.join(config.socketDirectory, 'verification.json'), report);
  console.log(JSON.stringify(report, null, 2));
} finally { ws.terminate(); }
