import { readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.router', 'coverage'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}
const all = await files(root);
for (const file of all) {
  if (file.endsWith('.json')) JSON.parse(await readFile(file, 'utf8'));
  if (file.endsWith('.mjs')) await exec(process.execPath, ['--check', file]);
}
const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const pkg = await json('package.json');
for (const file of ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json']) {
  const manifest = await json(file); assert.equal(manifest.name, pkg.name); assert.equal(manifest.version, pkg.version);
}
const hooks = await json('hooks/hooks.json');
assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PreToolUse', 'SessionStart', 'UserPromptSubmit']);
for (const event of Object.values(hooks.hooks)) for (const group of event) for (const hook of group.hooks) {
  assert.ok(hook.command.includes('${CLAUDE_PLUGIN_ROOT}/bin/router.mjs')); assert.equal(hook.type, 'command');
}
for (const file of ['bin/router.mjs', 'lib/mcp.mjs', 'skills/difficulty-routing/SKILL.md', 'mcp.json', '.mcp.json']) await access(path.join(root, file));
const skill = await readFile(path.join(root, 'skills/difficulty-routing/SKILL.md'), 'utf8');
assert.match(skill, /^---\nname: difficulty-routing\ndescription: .+\n---\n/);
console.log(`Validated ${all.length} files: JSON, JavaScript syntax, plugin manifests, hook paths and skill metadata.`);
