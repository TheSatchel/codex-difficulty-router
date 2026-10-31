// Default: native metadata verification only. --inference explicitly requests
// two short read-only turns through the real routing transport and account.
import { startRoutedServer } from '../lib/launcher.mjs';
import { RpcProcess } from '../lib/rpc.mjs';
import { applyVerifiedMode, sessionStatePath } from '../lib/codex.mjs';
import { readJSON, requireValue } from '../lib/ratings.mjs';
import { saveJSON } from '../lib/config.mjs';
import path from 'node:path';

const inference = process.argv.includes('--inference');
let server, rpc;
try {
  server = await startRoutedServer();
  rpc = new RpcProcess(server.controlCommand); await rpc.initialize();
  const { config, catalog } = server.profile;
  const root = config.ceiling;
  const created = await rpc.request('thread/start', { model: root.model,
    config: { model_reasoning_effort: root.effort }, serviceTier: 'default',
    ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
  const threadId = created.thread.id;
  const report = { modelCalls: 0, inferenceTurns: 0, threadId, localState: server.runDirectory, verifiedModes: [], turns: [] };
  const rootModel = catalog.find(m => m.model === root.model);
  let previous = { model: created.model, effort: created.reasoningEffort, serviceTier: created.serviceTier };
  for (const speed of ['normal', 'fast', 'ultrafast']) {
    if (!rootModel.speeds[speed]) continue;
    report.verifiedModes.push(await applyVerifiedMode(rpc, threadId, { ...root,
      speed, serviceTier: rootModel.speeds[speed] }, undefined, previous));
    previous = { model: root.model, effort: root.effort, serviceTier: rootModel.speeds[speed] };
  }
  if (inference) {
    delete report.modelCalls;
    const completed = new Map(), messages = new Map(), waiters = new Map();
    rpc.on('notification', message => {
      const p = message.params ?? {};
      if (p.threadId !== threadId) return;
      if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
        messages.set(p.turnId, [...(messages.get(p.turnId) ?? []), p.item.text]);
      }
      if (message.method === 'turn/completed') { completed.set(p.turn.id, p.turn); waiters.get(p.turn.id)?.(p.turn); }
    });
    for (const prompt of ['修复拼写：把 teh 改为 the。只回复更正后的词，不调用工具。',
      '请只用一句话回答：跨模块重构时，为什么要先固定 API 契约？不要调用工具。']) {
      const started = await rpc.request('turn/start', { threadId,
        input: [{ type: 'text', text: prompt }] });
      report.inferenceTurns++;
      const id = started.turn.id;
      const result = completed.get(id) ?? await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(id); reject(new Error('Native inference verification timed out.')); }, 180_000);
        waiters.set(id, turn => { clearTimeout(timer); waiters.delete(id); resolve(turn); });
      });
      const state = await readJSON(sessionStatePath(threadId));
      const entry = { turnId: id, status: result.status, actual: state.mode,
        hostConfirmed: state.source === 'native-settings-readback' && state.applied,
        output: (messages.get(id) ?? []).join('\n'), error: result.error };
      report.turns.push(entry); console.error(JSON.stringify(entry));
      requireValue(result.status === 'completed' && entry.output && entry.hostConfirmed,
        'INFERENCE_VERIFICATION_FAILED', 'A real routed turn failed.', entry);
    }
    requireValue(report.turns[0].actual.model !== report.turns[1].actual.model
      || report.turns[0].actual.effort !== report.turns[1].actual.effort,
    'MODE_DID_NOT_CHANGE', 'The host did not confirm a mode change between the two tasks.');
  }
  await saveJSON(path.join(server.runDirectory, 'verification.json'), report);
  console.log(JSON.stringify(report, null, 2));
} finally { rpc?.close(); if (server) await server.close(); }
