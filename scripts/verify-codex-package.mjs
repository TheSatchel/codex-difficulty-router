// Optional local verification with the real Codex plugin loader. No LLM turns.
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { codexBinary } from '../lib/config.mjs';
import { RpcProcess } from '../lib/rpc.mjs';
import { installCodexHooks } from '../lib/install-hooks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(tmpdir(), 'cdr package probe '));
const packageDirectory = path.join(temporary, 'plugin with spaces');
const probeProfileDirectory = path.join(temporary, 'isolated-codex-profile');
const exec = promisify(execFile);
// CODEX_HOME retains its documented meaning: this child gets a separate Codex
// configuration profile. The real user profile and authentication are untouched.
const probeEnvironment = { ...process.env, CODEX_HOME: probeProfileDirectory };
const probe = `router-probe-${randomUUID().slice(0, 8)}`;
const configFile = path.join(homedir(), '.codex', 'config.toml');
const hash = data => createHash('sha256').update(data).digest('hex');
const before = hash(await readFile(configFile));
let rpc;
try {
  await cp(root, packageDirectory, { recursive: true, filter: file => !['.git', 'node_modules', '.router', '.env', 'coverage'].includes(path.basename(file)) && !file.endsWith('.local.json') });
  for (const file of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
    const p = path.join(packageDirectory, file), manifest = JSON.parse(await readFile(p, 'utf8'));
    manifest.name = probe;
    await writeFile(p, JSON.stringify(manifest));
  }
  for (const file of ['mcp.json', 'codex.mcp.json']) {
    const p = path.join(packageDirectory, file), config = JSON.parse(await readFile(p, 'utf8'));
    config.mcpServers = { [probe]: config.mcpServers['difficulty-router'] };
    await writeFile(p, JSON.stringify(config));
  }
  await mkdir(path.join(packageDirectory, '.agents/plugins'), { recursive: true });
  await writeFile(path.join(packageDirectory, '.agents/plugins/marketplace.json'), JSON.stringify({ name: probe, plugins: [{
    name: probe, source: { source: 'local', path: './' }, category: 'Productivity',
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }
  }] }));
  await mkdir(probeProfileDirectory, { recursive: true });
  await exec(codexBinary(), ['plugin', 'marketplace', 'add', packageDirectory, '--json'], { env: probeEnvironment, cwd: '/', timeout: 20_000 });
  await exec(codexBinary(), ['plugin', 'add', `${probe}@${probe}`, '--json'], { env: probeEnvironment, cwd: '/', timeout: 20_000 });
  rpc = new RpcProcess([codexBinary(), '--enable', 'hooks', 'app-server'], { cwd: '/', env: probeEnvironment });
  await rpc.initialize();
  const inventory = await rpc.request('mcpServerStatus/list', { serverName: probe }, 20_000);
  const server = inventory.data.find(item => item.name === probe);
  assert.ok(server, 'Native loader did not discover the probe MCP.');
  assert.equal(server.toolsError ?? null, null, server.toolsError);
  assert.ok(server.tools.router_assess && server.tools.router_cache && server.tools.router_route && server.tools.router_dispatch,
    'Native plugin command failed to initialize/discover tools.');
  const started = await rpc.request('thread/start', { ephemeral: true, cwd: packageDirectory,
    model: 'gpt-6.1-sol', sandbox: 'read-only', approvalPolicy: 'never', config: { model_reasoning_effort: 'high' } });
  const bundled = await rpc.request('hooks/list', { threadId: started.thread.id });
  const bundledHooks = bundled.data.flatMap(item => item.hooks).filter(item => item.pluginId === probe || item.pluginId === `${probe}@${probe}`);
  const { version } = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  const bridge = await installCodexHooks({ codexDirectory: probeProfileDirectory, version });
  const hooks = await rpc.request('hooks/list', { cwds: [packageDirectory] });
  const own = hooks.data.flatMap(item => item.hooks).filter(item => item.source === 'user' && item.command?.includes(bridge.bridge));
  assert.equal(own.length, 3, `Expected all three absolute-path user hooks: ${JSON.stringify(hooks.data)}`);
  assert.ok(own.every(item => !item.command.includes('${')));
  assert.ok(own.every(item => item.trustStatus === 'untrusted'), 'Probe must not bypass hook trust.');
  assert.equal(hash(await readFile(configFile)), before, 'Global user configuration changed during the probe.');
  console.log(JSON.stringify({ success: true, cwd: '/', pluginPathHasSpaces: true,
    serverInfo: server.serverInfo, tools: Object.keys(server.tools), bundledHookCount: bundledHooks.length,
    userHookBridgeRequired: bundledHooks.length !== 3, hooks: own.map(item => ({
      event: item.eventName, enabled: item.enabled, trust: item.trustStatus
    })), globalConfigUnchanged: true, modelCalls: 0 }, null, 2));
} finally {
  if (rpc) {
    const stopped = rpc.child.exitCode === null ? once(rpc.child, 'exit') : Promise.resolve();
    rpc.close(); await stopped;
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
