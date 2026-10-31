import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
async function invoke(command, args, { input, env, cwd = '/' } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const result = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr })); });
  child.stdin.end(input); return result;
}

test('Codex and Claude manifests select separate host-compatible configurations', async () => {
  assert.equal((await json('.codex-plugin/plugin.json')).mcpServers, './codex.mcp.json');
  for (const file of ['mcp.json', 'codex.mcp.json']) {
    const server = (await json(file)).mcpServers['difficulty-router'];
    assert.deepEqual(server.args, ['${PLUGIN_ROOT}/bin/router.mjs', 'mcp']);
  }
  assert.deepEqual((await json('.mcp.json')).mcpServers['difficulty-router'].args, ['${CLAUDE_PLUGIN_ROOT}/bin/router.mjs', 'mcp']);
  assert.equal((await json('plugin.json')).extensions['com.openai'].hooks, './hooks/codex-hooks.json');
});

test('Codex MCP package resolves its native placeholder and starts from cwd /', async () => {
  const server = (await json('codex.mcp.json')).mcpServers['difficulty-router'];
  const args = server.args.map(value => value.replaceAll('${PLUGIN_ROOT}', root));
  const result = await invoke(process.execPath, args, { env: { ...process.env, CLAUDE_PLUGIN_ROOT: '' }, input:
    [{ id: 1, method: 'initialize', params: {} }, { id: 2, method: 'tools/list' }].map(JSON.stringify).join('\n') + '\n' });
  assert.equal(result.code, 0, result.stderr);
  const messages = result.stdout.trim().split('\n').map(JSON.parse);
  assert.ok(messages.find(m => m.id === 2).result.tools.some(tool => tool.name === 'router_assess'));
});

test('Codex hook works from / with only PLUGIN_ROOT, including paths with spaces', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'cdr hook path ')); t.after(() => rm(temporary, { force: true, recursive: true }));
  const pluginRoot = path.join(temporary, 'plugin with spaces');
  await cp(root, pluginRoot, { recursive: true, filter: file => !['.git', 'node_modules', '.router'].includes(path.basename(file)) });
  const hooks = await json('hooks/codex-hooks.json');
  const command = hooks.hooks.UserPromptSubmit[0].hooks[0].command;
  const result = await invoke('/bin/sh', ['-c', command], { env: { ...process.env,
    PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: path.join(temporary, 'data'), CDR_CONFIG: path.join(temporary, 'missing.json'),
    CLAUDE_PLUGIN_ROOT: '' }, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'fixture',
      cwd: temporary, prompt: 'Urgent spelling typo.' }) });
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.match(value.hookSpecificOutput.additionalContext, /"difficulty":"simple"/);
  assert.match(value.hookSpecificOutput.additionalContext, /"priority":"urgent"/);
});
