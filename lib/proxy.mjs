import { createInterface } from 'node:readline';
import { RpcProcess } from './rpc.mjs';
import { loadContext, backendCommand, saveJSON, withCatalog } from './config.mjs';
import { sessionStatePath, modeFromResponse, routingInstructions } from './codex.mjs';
import { assessTask, scanProject } from './assess.mjs';
import { routeTask } from './route.mjs';
import { requireValue, readJSON } from './ratings.mjs';

export async function startProxy({ input = process.stdin, output = process.stdout, diagnostics = process.stderr } = {}) {
  const rpc = new RpcProcess(backendCommand());
  const threads = new Map(), active = new Set();
  const send = message => output.write(`${JSON.stringify(message)}\n`);
  rpc.on('notification', message => {
    if (message.method === 'turn/started') active.add(message.params.threadId);
    if (message.method === 'turn/completed') active.delete(message.params.threadId);
    send(message);
  });
  rpc.on('serverRequest', send); // Preserve the host's approval/user-input flow.
  rpc.on('diagnostic', message => diagnostics.write(message));
  rpc.on('protocolError', message => diagnostics.write(`${message}\n`));
  const lines = createInterface({ input });
  try {
    for await (const line of lines) {
      let message;
      try { message = JSON.parse(line); }
      catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
      if (!message.method) { rpc.send(message); continue; }
      if (message.id === undefined) { rpc.send(message); continue; }
      try {
        let params = structuredClone(message.params ?? {}), decision;
        requireValue(!['review/start', 'thread/compact/start'].includes(message.method), 'UNROUTED_INFERENCE_METHOD',
          'This method can invoke a model without turn-level overrides. Use a routed turn for review or compaction work.');
        if (message.method === 'thread/start') params.allowProviderModelFallback = false;
        if (message.method === 'turn/start') {
          requireValue(!active.has(params.threadId), 'TURN_ALREADY_ACTIVE', 'Use turn/steer for an active turn; model/speed routing takes effect at a turn boundary.');
          const base = threads.get(params.threadId) ?? await rpc.request('thread/resume', { threadId: params.threadId, excludeTurns: true });
          requireValue(base.thread?.status?.type !== 'active', 'TURN_ALREADY_ACTIVE', 'The target thread is active in another client.');
          const context = await withCatalog(await loadContext(), rpc);
          requireValue(context.config.host === 'codex', 'HOST_MISMATCH', 'The proxy requires a Codex config.');
          const prompt = (params.input ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n') || 'Continue the existing engineering task.';
          const project = await scanProject(params.cwd ?? base.cwd);
          let prior;
          try { prior = await readJSON(sessionStatePath(params.threadId)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          let parent;
          if (prior?.depth > 0) {
            requireValue(prior.parentThreadId, 'MISSING_PARENT', 'Child thread has no recorded parent.');
            parent = modeFromResponse(await rpc.request('thread/resume', { threadId: prior.parentThreadId, excludeTurns: true }));
          }
          decision = routeTask({ ...context, parent, assessment: assessTask({ prompt, project }) });
          const selected = decision.selected;
          params = { ...params, model: selected.model, effort: selected.effort,
            serviceTier: selected.serviceTier, serviceTierForTurn: selected.serviceTier,
            additionalContext: { ...params.additionalContext,
              'codex-difficulty-router': { kind: 'application', value: routingInstructions(decision, { child: prior?.depth > 0 }) } } };
          if (params.collaborationMode) {
            params.collaborationMode.settings = { ...params.collaborationMode.settings,
              model: selected.model, reasoning_effort: selected.effort };
          }
          await saveJSON(sessionStatePath(params.threadId), {
            host: 'codex', mode: selected, route: decision, catalog: context.catalog,
            depth: prior?.depth ?? 0, parentThreadId: prior?.parentThreadId,
            observedAt: new Date().toISOString(), source: 'routed-turn-parameters'
          });
          diagnostics.write(`${JSON.stringify({ event: 'route', threadId: params.threadId,
            model: selected.model, effort: selected.effort, speed: selected.speed,
            priority: decision.assessment.priority, ...selected.economics })}\n`);
        }
        const result = await rpc.request(message.method, params);
        if (message.method === 'thread/start' || message.method === 'thread/resume') {
          threads.set(result.thread.id, result);
          // A resume may expose an active turn owned by another client.
          if (result.thread.status?.type === 'active') active.add(result.thread.id);
        }
        if (decision) {
          const old = threads.get(params.threadId);
          if (old) threads.set(params.threadId, { ...old, model: decision.selected.model,
            reasoningEffort: decision.selected.effort, serviceTier: decision.selected.serviceTier,
            thread: { ...old.thread, status: { type: 'idle' } } });
        }
        send({ jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32010, message: error.message,
          data: { code: error.code ?? 'ROUTING_ERROR', details: error.details ?? {} } } });
      }
    }
  } finally { rpc.close(); }
}
