import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { lstat, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { startRoutedServer } from './launcher.mjs';
import { codexBinary, dataDirectory, saveJSON } from './config.mjs';
import { requireValue } from './ratings.mjs';
import { VERSION } from './version.mjs';

const exec = promisify(execFile);
export const DESKTOP_LABEL = 'io.thesatchel.codex-difficulty-router';

export async function pluginState(binary = codexBinary()) {
  const { stdout } = await exec(binary, ['plugin', 'list', '--marketplace', 'satchel-routing', '--json'],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 1_000_000 });
  const plugin = JSON.parse(stdout).installed?.find(p => p.pluginId === 'codex-difficulty-router@satchel-routing');
  return { installed: plugin?.installed === true, enabled: plugin?.enabled === true,
    version: plugin?.version ?? null };
}

async function removeStaleSocket(file) {
  try { requireValue((await lstat(file)).isSocket(), 'UNOWNED_SOCKET_PATH', `Refusing to replace a normal file: ${file}`); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const live = await new Promise((resolve, reject) => {
    const socket = createConnection(file);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      socket.destroy();
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolve(false); else reject(error);
    });
  });
  requireValue(!live, 'ROUTER_ALREADY_RUNNING', 'A desktop routing service already owns this socket.');
  await unlink(file);
}

export async function serveDesktop({ socketDirectory = path.join(os.homedir(), '.codex', 'difficulty-router', 'desktop'),
  stateDirectory = dataDirectory(), binary = codexBinary(), queryPlugin = pluginState,
  command, context, trace = () => {} } = {}) {
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  await removeStaleSocket(path.join(socketDirectory, 'ui.sock'));
  await removeStaleSocket(path.join(socketDirectory, 'control.sock'));
  const statusFile = path.join(socketDirectory, 'status.json');
  let checked = 0, stopped = false, service, serial = Promise.resolve();
  const status = { kind: 'desktop-app-router', version: VERSION, pid: process.pid,
    running: false, routingEnabled: false, appConnections: 0, initializedByApp: false,
    startedAt: new Date().toISOString(), plugin: null };
  const persist = () => serial = serial.catch(() => {}).then(() => saveJSON(statusFile, { ...status }));
  async function enabled() {
    if (Date.now() - checked > 3000) {
      checked = Date.now();
      try {
        status.plugin = await queryPlugin(binary);
        status.routingEnabled = status.plugin.installed && status.plugin.enabled && status.plugin.version === VERSION;
      } catch { status.routingEnabled = false; status.plugin = { status: 'unavailable' }; }
      await persist();
    }
    return status.routingEnabled;
  }
  await enabled();
  const close = async () => {
    if (stopped) return; stopped = true;
    status.running = false; status.appConnections = 0;
    if (service) await service.close();
    await persist();
  };
  try {
    const bundledNode = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node';
    service = await startRoutedServer({
      command: command ?? [binary, '-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'],
      backendEnvironment: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop', LOG_FORMAT: 'json',
        CODEX_APP_RUNTIME_CLI_PATH: binary, CODEX_CLI_PATH: binary,
        ...(existsSync(bundledNode) ? { CODEX_MCP_NODE_PATH: bundledNode } : {}) },
      context, project: os.homedir(), socketDirectory, stateDirectory, statusFile,
      frontendOwnsInitialization: true, routingEnabled: enabled,
      onBackendClosed: error => { status.error = error.code ?? 'BACKEND_CLOSED'; void close().then(() => { process.exitCode = 1; }); },
      trace: event => {
        if (event.phase === 'frontend-connected') status.appConnections++;
        if (event.phase === 'frontend-disconnected') status.appConnections = Math.max(0, status.appConnections - 1);
        if (event.phase === 'frontend-input' && event.method === 'initialize') status.initializedByApp = true;
        if (['frontend-connected', 'frontend-disconnected'].includes(event.phase) || event.method === 'initialize') void persist();
        trace(event);
      }
    });
    status.running = true; status.appEndpoint = service.appEndpoint;
    status.controlSocket = service.controlSocket; status.configFile = service.configFile;
    status.eventsFile = path.join(service.runDirectory, 'events.jsonl');
    await persist();
    return { ...service, statusFile, close };
  } catch (error) { status.error = error.code ?? 'STARTUP_ERROR'; await close(); throw error; }
}
