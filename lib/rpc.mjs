import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { RoutingError, requireValue } from './ratings.mjs';

export class RpcProcess extends EventEmitter {
  constructor(command = ['codex', 'app-server', 'proxy'], options = {}) {
    super();
    requireValue(Array.isArray(command) && command.length > 0 && command.every(s => typeof s === 'string'), 'INVALID_COMMAND', 'Expected a command argv array.');
    this.pending = new Map(); this.sequence = 0; this.closed = false; this.lastDiagnostic = '';
    this.child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], ...options });
    this.child.stderr.on('data', data => {
      this.lastDiagnostic = (this.lastDiagnostic + data.toString()).slice(-4000);
      this.emit('diagnostic', data.toString());
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { this.emit('protocolError', 'Invalid backend JSON'); return; }
      if (message.method && message.id !== undefined) this.emit('serverRequest', message);
      else if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new RoutingError('RPC_ERROR', message.error.message, { rpc: message.error }));
        else pending.resolve(message.result);
      } else this.emit('notification', message);
    });
    this.child.once('error', error => this.fail(error));
    this.child.once('exit', (code, signal) => this.fail(new RoutingError('BACKEND_EXITED',
      `Codex backend exited (${code ?? signal}). For a missing control socket, start/connect the intended daemon or explicitly configure a standalone app-server.`,
      { diagnostic: this.lastDiagnostic.trim() })));
  }

  fail(error) {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit('closed', error);
  }

  send(message) {
    requireValue(!this.closed, 'BACKEND_CLOSED', 'Codex connection is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = `cdr-${++this.sequence}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RoutingError('RPC_TIMEOUT', `Timed out: ${method}.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'codex_difficulty_router', version: '0.2.0', title: 'Difficulty Router' },
      capabilities: { experimentalApi: true }
    });
    this.send({ jsonrpc: '2.0', method: 'initialized' });
    return result;
  }

  async models() {
    const models = []; let cursor;
    do {
      const result = await this.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      requireValue(Array.isArray(result.data), 'INVALID_CATALOG', 'Unrecognized Codex model catalog.');
      models.push(...result.data); cursor = result.nextCursor;
      requireValue(models.length < 10_000, 'CATALOG_LIMIT', 'Unexpected catalog pagination.');
    } while (cursor);
    return models;
  }

  close() { this.child.stdin.end(); this.child.kill(); this.lines.close(); }
}
