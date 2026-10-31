import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdtemp, chmod, rm, mkdir, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RpcProcess } from './rpc.mjs';
import { startProxy } from './proxy.mjs';
import { codexBinary, dataDirectory, configuredCache, loadContext, saveJSON, withCatalog } from './config.mjs';
import { automaticProfile } from './auto-profile.mjs';
import { requireValue } from './ratings.mjs';
import { sessionStatePath } from './codex.mjs';
import { WS_VERSION } from './version.mjs';
import { cachedSpeedPolicy } from './speed-policy.mjs';

function websocketServer() {
  const require = createRequire(process.env.CDR_RUNTIME_ROOT
    ? path.join(process.env.CDR_RUNTIME_ROOT, 'package.json') : import.meta.url);
  requireValue(require('ws/package.json').version === WS_VERSION, 'ROUTER_RUNTIME_OUTDATED', 'Run the Difficulty Router desktop installer for this version.');
  return require('ws').WebSocketServer;
}

// One real app-server owns every chat. Frontend connections share it, including
// MCP dispatch connections; opening another app-server would lose live state.
class Connection extends EventEmitter {
  constructor(hub) {
    super(); this.hub = hub; this.primary = false;
    this.notify = message => this.emit('notification', message);
    this.ask = message => { if (this.primary) this.emit('serverRequest', message); };
    this.closed = error => this.emit('closed', error);
    hub.rpc.on('notification', this.notify); hub.rpc.on('serverRequest', this.ask); hub.rpc.on('closed', this.closed);
  }
  async request(method, params) {
    if (method === 'initialize') {
      if (!this.hub.primary && params?.clientInfo?.name !== 'codex_difficulty_router') {
        this.primary = true; this.hub.primary = this;
      }
      if (this.hub.initialized === undefined) {
        requireValue(this.primary, 'DESKTOP_NOT_CONNECTED', 'Connect the desktop app before using its routing tools.');
        this.hub.initializing ??= this.hub.rpc.request('initialize', params);
        this.hub.initialized = await this.hub.initializing;
      }
      return this.hub.initialized;
    }
    return this.hub.rpc.request(method, params);
  }
  send(message) {
    if (message.method === 'initialized') {
      if (this.primary && this.hub.frontendOwnsInitialization && !this.hub.initializedSent) {
        this.hub.initializedSent = true; this.hub.rpc.send(message);
      }
      return;
    }
    // Approval replies belong to the native UI. A dispatcher cannot auto-approve
    // a request just because it has another connection to the same backend.
    if (!message.method && !this.primary) return;
    this.hub.rpc.send(message);
  }
  models() { return this.hub.rpc.models(); }
  close() {
    if (this.hub.primary === this) this.hub.primary = null;
    this.hub.rpc.off('notification', this.notify); this.hub.rpc.off('serverRequest', this.ask); this.hub.rpc.off('closed', this.closed);
    this.removeAllListeners();
  }
}

export async function startRoutedServer({ command, context, profileOptions = {}, project = process.cwd(),
  diagnostics, stateDirectory = dataDirectory(), trace = () => {}, socketDirectory,
  frontendOwnsInitialization = false, routingEnabled = async () => true,
  statusFile, onBackendClosed = () => {}, backendEnvironment = {} } = {}) {
  requireValue(process.platform !== 'win32', 'UNSUPPORTED_TRANSPORT', 'This launcher currently requires Unix sockets (macOS/Linux).');
  const WebSocketServer = websocketServer();
  const directory = socketDirectory ?? await mkdtemp(path.join(os.tmpdir(), 'cdr-'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const socket = path.join(directory, 'ui.sock');
  const controlSocket = path.join(directory, 'control.sock');
  const runDirectory = path.join(stateDirectory, 'launches', randomUUID());
  const configFile = path.join(runDirectory, 'routing.json');
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  // Keep the stdio entry outside the cache. If uninstall removes the module,
  // answer as an empty MCP instead of failing startup and refreshing forever.
  const mcpEntry = path.join(runDirectory, 'mcp-entry.mjs');
  await writeFile(mcpEntry, `import {createInterface} from 'node:readline';
let serve;
try { ({serveMcp:serve}=await import(${JSON.stringify(new URL('./mcp.mjs', import.meta.url).href)})); } catch {}
if(serve) await serve(); else {
  const send=v=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+String.fromCharCode(10));
  for await(const line of createInterface({input:process.stdin})) {
    let m; try {m=JSON.parse(line);} catch {continue;}
    if(m.id===undefined) continue;
    if(m.method==='initialize') send({id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'difficulty-router',version:'0.0.0-inactive'}}});
    else if(m.method==='tools/list') send({id:m.id,result:{tools:[]}});
    else if(m.method==='ping') send({id:m.id,result:{}});
    else send({id:m.id,error:{code:-32601,message:'Difficulty Router is no longer installed.'}});
  }
}
`, { mode: 0o600 });
  const ownLog = diagnostics ? null : createWriteStream(path.join(runDirectory, 'events.jsonl'), { mode: 0o600 });
  diagnostics ??= ownLog;
  const binary = codexBinary();
  const control = [binary, 'app-server', 'proxy', '--sock', controlSocket];
  const overrides = {
    CDR_CONFIG: configFile, CDR_CODEX_COMMAND: JSON.stringify(control),
    CDR_DATA_DIR: stateDirectory, CDR_PROJECT_ROOT: path.resolve(project),
    ...(statusFile ? { CDR_DESKTOP_STATUS_FILE: statusFile } : {})
  };
  const backendArgs = ['-c', `mcp_servers.difficulty-router.command=${JSON.stringify(process.execPath)}`,
    '-c', `mcp_servers.difficulty-router.args=${JSON.stringify([mcpEntry])}`,
    ...Object.entries(overrides).flatMap(([key, value]) =>
    ['-c', `mcp_servers.difficulty-router.env.${key}=${JSON.stringify(value)}`])];
  const rpc = new RpcProcess([...(command ?? [binary, 'app-server']), ...backendArgs], {
    cwd: path.resolve(project), env: { ...process.env, ...backendEnvironment, ...overrides }
  });
  rpc.setMaxListeners(64);
  // Diagnostics are local files, never protocol notifications or prompt text.
  rpc.on('diagnostic', () => {});
  let server, http, wss, profile = context, rootThreadId;
  const activeRoots = new Set();
  let writingRoots = Promise.resolve();
  const saveRoots = () => writingRoots = writingRoots.catch(() => {}).then(async () => {
    if (profile) {
      profile.config = { ...profile.config, activeRootThreadIds: [...activeRoots] };
      await saveJSON(configFile, profile.config);
    }
  });
  const connections = new Set(), jobs = new Set();
  let stopped = false;
  const close = async () => {
    if (stopped) return; stopped = true;
    for (const connection of connections) connection.terminate ? connection.terminate() : connection.destroy();
    wss?.close();
    await Promise.all([server, http].map(listener => new Promise(resolve => listener?.listening ? listener.close(resolve) : resolve())));
    rpc.close();
    await Promise.allSettled([...jobs]);
    ownLog?.end();
    if (!socketDirectory) await rm(directory, { recursive: true, force: true });
    else await Promise.allSettled([socket, controlSocket].map(file => unlink(file)));
  };
  try {
    const initialized = frontendOwnsInitialization ? undefined : await rpc.initialize();
    trace({ phase: 'backend-initialized' });
    let refreshing, metadataRefresh;
    const refreshMetadata = () => metadataRefresh ??= Promise.all([configuredCache(), cachedSpeedPolicy()])
      .finally(() => { metadataRefresh = null; });
    async function resolveContext() {
      if (!refreshing) refreshing = (async () => {
        if (context) profile = await withCatalog(context, rpc);
        else if (process.env.CDR_CONFIG) profile = await withCatalog(await loadContext(), rpc);
        else {
          let [cached, policy] = await Promise.all([configuredCache({}, { cacheOnly: true }), cachedSpeedPolicy({ cacheOnly: true })]);
          if (cached.usable) void refreshMetadata().catch(() => {});
          else [cached, policy] = await refreshMetadata();
          requireValue(cached.usable, 'RATINGS_CACHE_UNAVAILABLE', 'A fresh measured leaderboard cache is required before inference.');
          profile = automaticProfile({ snapshot: cached.snapshot, models: await rpc.models(),
            ...profileOptions, policy, ...(profile ? { ceiling: profile.config.ceiling } : {}) });
        }
        if (rootThreadId) profile.config = { ...profile.config, rootThreadId };
        profile.config = { ...profile.config, activeRootThreadIds: [...activeRoots] };
        await saveJSON(configFile, profile.config);
        return profile;
      })().finally(() => { refreshing = null; });
      return refreshing;
    }
    if (!frontendOwnsInitialization) await resolveContext();
    trace({ phase: 'profile-ready' });
    const hub = { rpc, initialized, primary: null, frontendOwnsInitialization, initializedSent: !frontendOwnsInitialization };
    rpc.on('notification', message => {
      if (message.method === 'turn/completed' && activeRoots.delete(message.params.threadId)) void saveRoots();
    });
    rpc.once('closed', error => {
      if (!stopped) { for (const peer of connections) peer.terminate ? peer.terminate() : peer.destroy(); onBackendClosed(error); }
    });
    http = createServer((_request, response) => { response.writeHead(404); response.end(); });
    wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
    http.on('upgrade', (request, stream, head) => {
      if (request.headers.origin) { stream.destroy(); return; }
      wss.handleUpgrade(request, stream, head, ws => wss.emit('connection', ws));
    });
    function connect(input, output, peer) {
      connections.add(peer);
      const view = new Connection(hub);
      const job = startProxy({ input, output, diagnostics, rpc: view, contextProvider: resolveContext, routingEnabled,
        statePath: id => path.join(stateDirectory, 'sessions', path.basename(sessionStatePath(id))),
        onRoutedTurn: async (id, depth) => {
          if (view.primary && depth === 0) { activeRoots.add(id); await saveRoots(); }
        },
        onRouteRejected: async id => { if (activeRoots.delete(id)) await saveRoots(); },
        onRootThread: async id => {
          if (!view.primary) return;
          rootThreadId = id;
          if (profile) { profile.config = { ...profile.config, rootThreadId }; await saveRoots(); }
        } });
      jobs.add(job);
      job.catch(error => { diagnostics.write(`Routing connection stopped: ${error.message}\n`); peer.terminate ? peer.terminate() : peer.destroy(); })
        .finally(() => { jobs.delete(job); connections.delete(peer); if (!peer.terminate) peer.end(); });
    }
    wss.on('connection', ws => {
      trace({ phase: 'frontend-connected' });
      const input = new PassThrough();
      let buffered = '';
      const output = new Writable({ write(chunk, _encoding, done) {
        buffered += chunk.toString();
        for (;;) {
          const end = buffered.indexOf('\n'); if (end < 0) break;
          const message = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
          delete message.jsonrpc;
          trace({ phase: 'frontend-output', method: message.method, id: message.id });
          if (ws.readyState === 1) ws.send(JSON.stringify(message));
        }
        done();
      } });
      ws.on('message', data => {
        try { const m = JSON.parse(data.toString()); trace({ phase: 'frontend-input', method: m.method, id: m.id }); } catch {}
        input.write(`${data.toString()}\n`);
      });
      ws.on('error', () => input.end());
      ws.on('close', () => { trace({ phase: 'frontend-disconnected' }); connections.delete(ws); input.end(); });
      connect(input, output, ws);
    });
    // The native TUI uses WebSocket Upgrade on Unix; the CLI's older
    // `app-server proxy --sock` copies raw JSONL. Separate private sockets share
    // one owner, without mixing transport framing or opening a TCP listener.
    server = createSocketServer(stream => {
      stream.on('error', () => stream.destroy());
      connect(stream, stream, stream);
    });
    await Promise.all([[http, socket], [server, controlSocket]].map(([listener, target]) => new Promise((resolve, reject) => {
      listener.once('error', reject); listener.listen(target, resolve);
    })));
    await Promise.all([socket, controlSocket].map(target => chmod(target, 0o600)));
    return { socket, controlSocket, endpoint: `unix://${socket}`, appEndpoint: `ws+unix://${socket}:/rpc`,
      get profile() { return profile; }, configFile, runDirectory, controlCommand: control,
      request: (method, params) => rpc.request(method, params), close };
  } catch (error) { await close(); throw error; }
}

export async function launchCodex(options = {}, args = []) {
  const routed = await startRoutedServer(options);
  const keepNativeInterrupt = () => {};
  process.on('SIGINT', keepNativeInterrupt);
  try {
    process.stderr.write(`Difficulty Router · native Codex UI\nUpper bound: ${JSON.stringify(routed.profile.config.ceiling)}\nLocal state: ${routed.runDirectory}\n`);
    const selected = routed.profile.config.ceiling;
    const child = spawn(codexBinary(), ['--remote', routed.endpoint, '--model', selected.model,
      '-c', `model_reasoning_effort=${JSON.stringify(selected.effort)}`,
      '-c', 'service_tier="default"', ...args], { cwd: options.project ?? process.cwd(), stdio: 'inherit' });
    return await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
    });
  } finally { process.off('SIGINT', keepNativeInterrupt); await routed.close(); }
}
