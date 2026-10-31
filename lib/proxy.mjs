import { createInterface } from 'node:readline';
import { RpcProcess } from './rpc.mjs';
import { loadContext, backendCommand, saveJSON, withCatalog } from './config.mjs';
import { sessionStatePath, modeFromResponse, applyVerifiedMode } from './codex.mjs';
import { assessTask, scanProject } from './assess.mjs';
import { routeTask } from './route.mjs';
import { requireValue, readJSON } from './ratings.mjs';

export async function startProxy({ input = process.stdin, output = process.stdout, diagnostics = process.stderr,
  rpc = new RpcProcess(backendCommand()), contextProvider = async () => withCatalog(await loadContext(), rpc),
  onRootThread = async () => {}, statePath = sessionStatePath, routingEnabled = async () => true,
  onRoutedTurn = async () => {}, onRouteRejected = async () => {} } = {}) {
  const threads = new Map(), active = new Set(), knownSettings = new Map();
  const send = message => output.write(`${JSON.stringify(message)}\n`);
  rpc.on('notification', message => {
    if (message.method === 'thread/settings/updated') knownSettings.set(message.params.threadId, message.params.threadSettings);
    if (message.method === 'turn/started') active.add(message.params.threadId);
    if (message.method === 'turn/completed') active.delete(message.params.threadId);
    send(message);
  });
  rpc.on('serverRequest', send); // Preserve the host's approval/user-input flow.
  rpc.on('diagnostic', message => diagnostics.write(message));
  rpc.on('protocolError', message => diagnostics.write(`${message}\n`));
  const lines = createInterface({ input });
  // A host request can wait for an approval/server-request reply. Forward those
  // replies immediately even while the ordinary request queue is awaiting RPC.
  const forwardResponse = line => {
    try {
      const message = JSON.parse(line);
      if (!message.method && message.id !== undefined && ('result' in message || 'error' in message)) rpc.send(message);
    } catch { /* The request loop reports malformed input. */ }
  };
  lines.on('line', forwardResponse);
  const endInput = () => lines.close();
  input.once('close', endInput); input.once('error', endInput);
  try {
    for await (const line of lines) {
      let message;
      try { message = JSON.parse(line); }
      catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
      if (!message.method) continue;
      if (message.id === undefined) { rpc.send(message); continue; }
      let routedThread;
      try {
        let params = structuredClone(message.params ?? {}), decision, pendingState;
        const enabled = await routingEnabled();
        requireValue(!enabled || !['review/start', 'thread/compact/start'].includes(message.method), 'UNROUTED_INFERENCE_METHOD',
          'This method can invoke a model without turn-level overrides. Use a routed turn for review or compaction work.');
        if (enabled && ['thread/settings/update', 'turn/settings/update'].includes(message.method)
          && ['model', 'effort', 'serviceTier', 'collaborationMode'].some(key => key in params)) {
          const live = await rpc.request('thread/read', { threadId: params.threadId, includeTurns: false });
          requireValue(live.thread.status?.type !== 'active', 'ROUTE_AT_TURN_BOUNDARY',
            'Resource settings for an active turn cannot bypass routing. Apply the selection at the next turn boundary.');
        }
        if (enabled && message.method === 'thread/start') {
          params.allowProviderModelFallback = false;
          // Current published rated variants stop below Ultra. Keep native
          // subagent tools unavailable; independent thread dispatch uses RPC.
          params.config = { ...params.config, 'features.multi_agent': false };
        }
        if (enabled && message.method === 'turn/start') {
          requireValue(!active.has(params.threadId), 'TURN_ALREADY_ACTIVE', 'Use turn/steer for an active turn; model/speed routing takes effect at a turn boundary.');
          const base = threads.get(params.threadId) ?? await rpc.request('thread/resume', { threadId: params.threadId, excludeTurns: true });
          const live = await rpc.request('thread/read', { threadId: params.threadId, includeTurns: false });
          requireValue(live.thread.status?.type !== 'active' && live.thread.canAcceptDirectInput === true,
            'TURN_ALREADY_ACTIVE', 'The target thread is active or is not owned by this routing connection.');
          const context = await contextProvider();
          requireValue(context.config.host === 'codex', 'HOST_MISMATCH', 'The proxy requires a Codex config.');
          const prompt = (params.input ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n') || 'Continue the existing engineering task.';
          const project = await scanProject(params.cwd ?? base.cwd);
          let prior;
          try { prior = await readJSON(statePath(params.threadId)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          let parent;
          if (prior?.depth > 0) {
            requireValue(prior.parentThreadId, 'MISSING_PARENT', 'Child thread has no recorded parent.');
            parent = modeFromResponse(await rpc.request('thread/resume', { threadId: prior.parentThreadId, excludeTurns: true }));
          }
          let assessment = assessTask({ prompt, project });
          if (prior?.route?.assessment && /^(继续|接着|按.+[来做]|修好它|做吧|开始|好|嗯|可以|ok|continue|go ahead|proceed|yes|resume|retry|再试(?:一次)?)[。.!！\s]*$/i.test(prompt.trim())) {
            assessment = { ...prior.route.assessment, project,
              factors: [...prior.route.assessment.factors, 'continuation retains the previous task floor'] };
          }
          decision = routeTask({ ...context, parent, assessment });
          const selected = decision.selected;
          params = { ...params, model: selected.model, effort: selected.effort,
            serviceTier: selected.serviceTier, serviceTierForTurn: selected.serviceTier };
          if (params.collaborationMode) {
            params.collaborationMode.settings = { ...params.collaborationMode.settings,
              model: selected.model, reasoning_effort: selected.effort };
          }
          const previous = knownSettings.get(params.threadId) ?? { model: base.model,
            effort: base.reasoningEffort, serviceTier: base.serviceTier };
          const actual = await applyVerifiedMode(rpc, params.threadId, selected, params.collaborationMode, previous);
          pendingState = {
            host: 'codex', mode: actual, route: decision, catalog: context.catalog,
            depth: prior?.depth ?? 0, parentThreadId: prior?.parentThreadId,
            observedAt: new Date().toISOString(), source: 'native-settings-readback', applied: false
          };
          await saveJSON(statePath(params.threadId), pendingState);
          routedThread = params.threadId;
          await onRoutedTurn(params.threadId, pendingState.depth);
          diagnostics.write(`${JSON.stringify({ event: 'route', threadId: params.threadId,
            model: selected.model, effort: selected.effort, speed: selected.speed,
            priority: decision.assessment.priority, ...selected.economics })}\n`);
        }
        const result = await rpc.request(message.method, params);
        if (message.method === 'thread/start' || message.method === 'thread/resume') {
          threads.set(result.thread.id, result);
          knownSettings.set(result.thread.id, { model: result.model, effort: result.reasoningEffort, serviceTier: result.serviceTier });
          await onRootThread(result.thread.id);
          // A resume may expose an active turn owned by another client.
          if (result.thread.status?.type === 'active') active.add(result.thread.id);
        }
        if (decision) {
          await saveJSON(statePath(params.threadId), { ...pendingState, applied: true, turnId: result.turn.id });
          const old = threads.get(params.threadId);
          if (old) threads.set(params.threadId, { ...old, model: decision.selected.model,
            reasoningEffort: decision.selected.effort, serviceTier: decision.selected.serviceTier,
            thread: { ...old.thread, status: { type: 'idle' } } });
        }
        send({ jsonrpc: '2.0', id: message.id, result });
      } catch (error) {
        if (routedThread) await onRouteRejected(routedThread);
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32010, message: error.message,
          data: { code: error.code ?? 'ROUTING_ERROR', details: error.details ?? {} } } });
      }
    }
  } finally {
    input.off('close', endInput); input.off('error', endInput); lines.off('line', forwardResponse); lines.close(); rpc.close();
  }
}
