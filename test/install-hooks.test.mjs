import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile, readFile, mkdir, cp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { installCodexHooks } from '../lib/install-hooks.mjs';

const root = path.resolve(import.meta.dirname, '..');
async function folder(t) { const result = await mkdtemp(path.join(tmpdir(), "cdr hooks ' ")); t.after(() => rm(result, { recursive: true, force: true })); return result; }
async function runBridge(script, version, env, input) {
  const child = spawn(process.execPath, [script, version], { cwd: '/', env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', x => { stdout += x; }); child.stderr.on('data', x => { stderr += x; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr })); });
  child.stdin.end(JSON.stringify(input)); return done;
}

test('user-hook installation preserves other hooks, backs up the file, and is idempotent', async t => {
  const directory = await folder(t), file = path.join(directory, 'hooks.json');
  const existing = { description: 'User settings', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'user-owned-command' }] }] } };
  await writeFile(file, JSON.stringify(existing));
  const first = await installCodexHooks({ codexDirectory: directory, version: '0.2.1' });
  assert.deepEqual(JSON.parse(await readFile(first.backup, 'utf8')), existing);
  await installCodexHooks({ codexDirectory: directory, version: '0.2.1' });
  const installed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(installed.description, 'User settings');
  assert.equal(installed.hooks.SessionStart.length, 2); assert.equal(installed.hooks.UserPromptSubmit.length, 1);
  assert.equal(installed.hooks.SessionStart[0].hooks[0].command, 'user-owned-command');
  assert.ok(installed.hooks.PreToolUse[0].hooks[0].command.includes("'\\''"));
  assert.equal(installed.trust, undefined); // Never generate a trusted/managed hook.
});

test('bridge no-ops for a disabled plugin or a version that has not been reviewed', async t => {
  const directory = await folder(t), fake = path.join(directory, 'fake-codex.mjs');
  await writeFile(fake, 'console.log(JSON.stringify({installed:[{pluginId:"codex-difficulty-router@satchel-routing",installed:true,enabled:false,version:"0.2.1"}]}));');
  const result = await installCodexHooks({ codexDirectory: directory, version: '0.2.1', codexCommand: [process.execPath, fake] });
  const disabled = await runBridge(result.bridge, '0.2.1', process.env, {});
  assert.equal(disabled.code, 0); assert.deepEqual(JSON.parse(disabled.stdout), {});
  await writeFile(fake, 'console.log(JSON.stringify({installed:[{pluginId:"codex-difficulty-router@satchel-routing",installed:true,enabled:true,version:"0.2.2"}]}));');
  const newer = await runBridge(result.bridge, '0.2.1', process.env, {});
  assert.equal(newer.code, 0); assert.deepEqual(JSON.parse(newer.stdout), {});
});

test('bridge invokes the exact enabled installed version from / and returns real assessment', async t => {
  const directory = await folder(t), fake = path.join(directory, 'fake-codex.mjs');
  await writeFile(fake, 'console.log(JSON.stringify({installed:[{pluginId:"codex-difficulty-router@satchel-routing",installed:true,enabled:true,version:"0.2.1"}]}));');
  const installedRoot = path.join(directory, 'plugins/cache/satchel-routing/codex-difficulty-router/0.2.1');
  await mkdir(path.dirname(installedRoot), { recursive: true });
  await cp(root, installedRoot, { recursive: true, filter: p => !['.git', 'node_modules', '.router'].includes(path.basename(p)) });
  const result = await installCodexHooks({ codexDirectory: directory, version: '0.2.1', codexCommand: [process.execPath, fake] });
  const assessment = await runBridge(result.bridge, '0.2.1', { ...process.env, CDR_CONFIG: path.join(directory, 'not-configured.json') },
    { hook_event_name: 'UserPromptSubmit', session_id: 'test', cwd: directory, prompt: 'Urgent spelling typo.' });
  assert.equal(assessment.code, 0, assessment.stderr);
  assert.match(JSON.parse(assessment.stdout).hookSpecificOutput.additionalContext, /"difficulty":"simple"/);
});
