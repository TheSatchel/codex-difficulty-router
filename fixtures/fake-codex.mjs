// Test transport only. No model, network or real Codex invocation.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { demoData } from '../examples/demo-data.mjs';
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const threads = new Map(); let sequence = 0, awaitingApproval;
function thread(id, params = {}) {
  return { model: params.model ?? 'demo-strong', reasoningEffort: params.config?.model_reasoning_effort ?? 'ultra',
    serviceTier: params.serviceTier ?? 'ultrafast', cwd: process.cwd(), approvalPolicy: 'onRequest', approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false },
    thread: { id, status: { type: 'idle' }, parentThreadId: null, projectId: null, canAcceptDirectInput: true } };
}
threads.set('main', thread('main'));
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line), p = message.params ?? {};
  if (message.id === 'fixture-approval' && !message.method && awaitingApproval) {
    send({ id: awaitingApproval, result: { approved: message.result?.decision === 'accept' } });
    awaitingApproval = null; continue;
  }
  if (process.env.CDR_TEST_LOG) appendFileSync(process.env.CDR_TEST_LOG, JSON.stringify(message) + '\n');
  if (message.id === undefined || !message.method) continue;
  let result;
  if (message.method === 'fixture/approval') {
    awaitingApproval = message.id;
    send({ id: 'fixture-approval', method: 'fixture/requestApproval', params: { fixtureOnly: true } });
    continue;
  }
  if (message.method === 'initialize') result = { userAgent: 'fake-server-only', clientName: p.clientInfo?.name };
  else if (message.method === 'model/list') result = { data: demoData().catalog.map(m => ({
    model: m.model, hidden: false, supportedReasoningEfforts: m.efforts.map(reasoningEffort => ({ reasoningEffort })),
    serviceTiers: Object.values(m.speeds).map(id => ({ id, name: id, description: 'fake' }))
  })), nextCursor: null };
  else if (message.method === 'thread/start') {
    const id = `mock-${++sequence}`; result = thread(id, p); threads.set(id, result);
  } else if (message.method === 'thread/resume') result = threads.get(p.threadId) ?? thread(p.threadId);
  else if (message.method === 'thread/read') {
    const current = threads.get(p.threadId) ?? thread(p.threadId);
    result = { thread: { ...current.thread, model: current.model, reasoningEffort: current.reasoningEffort } };
  }
  else if (message.method === 'thread/settings/update') {
    const current = threads.get(p.threadId) ?? thread(p.threadId);
    if (!process.argv.includes('--reject-settings')) threads.set(p.threadId, { ...current, model: p.model ?? current.model,
      reasoningEffort: p.effort ?? current.reasoningEffort, serviceTier: p.serviceTier ?? current.serviceTier });
    result = {};
    const value = threads.get(p.threadId);
    if (value.model !== current.model || value.reasoningEffort !== current.reasoningEffort || value.serviceTier !== current.serviceTier)
      send({ method: 'thread/settings/updated', params: { threadId: p.threadId,
        threadSettings: { model: value.model, effort: value.reasoningEffort, serviceTier: value.serviceTier } } });
  }
  else if (message.method === 'turn/start') {
    const id = `turn-${++sequence}`;
    result = { turn: { id, status: 'inProgress' } };
    send({ id: message.id, result });
    send({ method: 'item/completed', params: { threadId: p.threadId, turnId: id, item: { type: 'agentMessage', text: `Result from ${p.threadId}` } } });
    send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: process.env.CDR_TEST_FAIL_TURN ? 'failed' : 'completed', error: null } } });
    continue;
  } else result = { echoed: p };
  send({ id: message.id, result });
}
